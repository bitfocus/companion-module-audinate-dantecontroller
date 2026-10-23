/**
 * mDNS on one socket per network card.
 */

import multidns from 'multicast-dns'
import type dgram from 'node:dgram'
import { addressOnInterface, type NetworkInterfaceInfo } from '../config.js'
import type { MdnsResponsePacket } from './types.js'

type Mdns = multidns.MulticastDNS
type Query = multidns.QueryOutgoingPacket
type QueryCallback = (error: Error | null) => void

/** Somewhere a follow-up query can be sent: the card a response arrived on. */
export interface MdnsSender {
	query(query: Query, callback?: QueryCallback): void
}

/** What the group reports, for every card's socket. */
export interface MdnsGroupHandlers {
	/** A response from a device on `via`'s card. Follow-up queries go back out through `via`. */
	response(response: MdnsResponsePacket, rinfo: dgram.RemoteInfo, via: MdnsSender): void
	/** A card's socket is bound and can receive. */
	ready(nic: NetworkInterfaceInfo): void
	/** A card's socket failed, which `multicast-dns` treats as fatal. `allFailed` when no card is left. */
	error(error: Error, nic: NetworkInterfaceInfo, allFailed: boolean): void
	/** Non-fatal: a malformed packet, or a membership or interface that could not be set. */
	warning(error: Error, nic: NetworkInterfaceInfo): void
	/** A card joined or left the group. */
	cardsChanged(added: NetworkInterfaceInfo[], removed: NetworkInterfaceInfo[]): void
}

interface Member {
	nic: NetworkInterfaceInfo
	mdns: Mdns
	failed: boolean
	/** Set once a send from this card has failed, so a card that cannot send is reported once. */
	sendFailing: boolean
}

/** One card's socket: it joins the group on that card only, and sends its queries out of it. */
function socketForCard(nic: NetworkInterfaceInfo): Mdns {
	// `multicast-dns` binds `bind ?? interface`, and a socket bound to a unicast address can miss
	// multicast-addressed replies on macOS/BSD - so bind the wildcard address and let `interface`
	// scope the membership and the outgoing card.
	return multidns({ interface: nic.address, bind: '0.0.0.0' })
}

/**
 * Drops a socket's handlers, keeping one that ignores errors: `multicast-dns` returns a bare
 * EventEmitter, and an 'error' with no listener throws and takes the module process down.
 */
function detach(mdns: Mdns): void {
	mdns.removeAllListeners()
	mdns.on('error', () => undefined)
}

/**
 * mDNS discovery across several network cards at once.
 *
 * A single `multicast-dns` socket with no interface joins the group on every card, so it hears
 * replies from all of them - but it sends every query out of one card, which on macOS is always
 * `en0`. On a machine whose Dante network is on another card, the devices there never hear the
 * module ask, and only find it through their own unsolicited announcements, if at all. So the
 * automatic network card found nothing at all on a Mac with Wi-Fi as `en0` and Dante on a USB adapter.
 *
 * Here each card gets a socket of its own, which joins the group on that card and sends out of it.
 * A query goes out every card, and a follow-up query goes back out the card its response came in
 * on. {@link sync} adds and drops cards as they come and go, so a card plugged in later is
 * discovered on without reconnecting.
 *
 * Every socket binds the wildcard address, and Linux delivers a group's traffic to every such
 * socket whatever card it arrived on. A response is therefore handled only by the card whose subnet
 * holds its source, and by every card when none does (a link-local device seen from a card with a
 * routable address, say). mDNS is link-local, so the subnet test cannot drop a device on a routed
 * network - multicast never crossed that router to begin with.
 */
export class MdnsGroup implements MdnsSender {
	readonly #members = new Map<string, Member>()
	#closed = false

	constructor(
		private readonly handlers: MdnsGroupHandlers,
		private readonly createSocket: (nic: NetworkInterfaceInfo) => Mdns = socketForCard,
	) {}

	/** The cards currently being discovered on. */
	get cards(): NetworkInterfaceInfo[] {
		return [...this.#members.values()].map((member) => member.nic)
	}

	/**
	 * Makes the group cover exactly `nics`: opens a socket on each new card, closes the sockets of
	 * cards that went away. A card is keyed by its address, so one whose address changed is replaced.
	 */
	sync(nics: NetworkInterfaceInfo[]): void {
		if (this.#closed) return

		const wanted = new Map(nics.map((nic) => [nic.address, nic]))
		const removed: NetworkInterfaceInfo[] = []
		for (const [address, member] of [...this.#members]) {
			if (wanted.has(address)) continue
			this.#close(member)
			this.#members.delete(address)
			removed.push(member.nic)
		}

		const added: NetworkInterfaceInfo[] = []
		for (const [address, nic] of wanted) {
			if (this.#members.has(address)) continue
			this.#members.set(address, this.#open(nic))
			added.push(nic)
		}

		if (added.length > 0 || removed.length > 0) this.handlers.cardsChanged(added, removed)
	}

	/**
	 * Sends a query out of every card. The callback hears about a card that cannot send once, rather
	 * than on every sweep, and again only after that card has sent successfully in between.
	 */
	query(query: Query, callback?: QueryCallback): void {
		for (const member of this.#members.values()) {
			if (!member.failed) this.#send(member, query, callback)
		}
	}

	/** Detaches every handler. The group stops reporting, but keeps its sockets until {@link destroy}. */
	removeAllListeners(): void {
		for (const member of this.#members.values()) detach(member.mdns)
	}

	/** Closes every card's socket. The group cannot be reused afterwards. */
	destroy(): void {
		this.#closed = true
		for (const member of this.#members.values()) this.#close(member)
		this.#members.clear()
	}

	#open(nic: NetworkInterfaceInfo): Member {
		const member: Member = { nic, mdns: this.createSocket(nic), failed: false, sendFailing: false }
		const via: MdnsSender = { query: (query, callback) => this.#send(member, query, callback) }

		member.mdns.on('response', (response, rinfo) => {
			if (!this.#handles(member, rinfo.address)) return
			this.handlers.response(response as unknown as MdnsResponsePacket, rinfo, via)
		})
		member.mdns.on('ready', () => this.handlers.ready(nic))
		member.mdns.on('warning', (error: Error) => this.handlers.warning(error, nic))
		member.mdns.on('error', (error: Error) => {
			member.failed = true
			const allFailed = [...this.#members.values()].every((other) => other.failed)
			this.handlers.error(error, nic, allFailed)
		})
		return member
	}

	#send(member: Member, query: Query, callback?: QueryCallback): void {
		member.mdns.query(query, (error) => {
			if (!error) {
				member.sendFailing = false
				return
			}
			if (member.sendFailing) return
			member.sendFailing = true
			callback?.(new Error(`${member.nic.name} (${member.nic.address}) : ${error.message}`))
		})
	}

	/** Whether `member` is the card to handle a response from `source`. See the class comment. */
	#handles(member: Member, source: string): boolean {
		if (addressOnInterface(member.nic, source)) return true
		for (const other of this.#members.values()) {
			if (other !== member && addressOnInterface(other.nic, source)) return false
		}
		return true
	}

	#close(member: Member): void {
		detach(member.mdns)
		try {
			member.mdns.destroy()
		} catch {
			// already closed - nothing to do on teardown
		}
	}
}
