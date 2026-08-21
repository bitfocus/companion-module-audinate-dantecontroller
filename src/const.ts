import type { DropdownChoice } from '@companion-module/base'

/** Encoding codes this module knows how to label. */
export type EncodingCode = 16 | 24 | 32
/** Output level codes this module knows how to label. */
export type LevelCode = 1 | 2 | 3 | 4 | 5
/** Sample rate pullup codes this module knows how to label. */
export type PullupCode = 0 | 1 | 2 | 3 | 4

export const DANTE_CONST = {
	SERVICES: {
		ARC: '_netaudio-arc._udp.local',
		CMC: '_netaudio-cmc._udp.local',
	},

	get SERVICES_ARRAY(): string[] {
		return Object.values(DANTE_CONST.SERVICES)
	},

	AUDINATE_BUFFER: Buffer.concat([Buffer.from('Audinate', 'ascii'), Buffer.from('0734', 'hex')]),

	MULTICAST_IP: {
		INFO: '224.0.0.231',
		HEARTBEAT: '224.0.0.233',
	},

	/**
	 * How many channel records a device returns per query page, per direction. These differ, and the
	 * value is a property of the protocol rather than of the device - a reply never carries more
	 * records than this, whatever its record-count byte claims.
	 */
	CHANNELS_PER_PAGE: {
		RX: 16,
		TX: 32,
	},

	PORTS: {
		ARC: 4440,
		SETTINGS: 8700,
		DVS_SETTINGS: 38700,
		INFO: 8702,
		HEARTBEAT: 8708,
		CMC: 8800,
		DVS_CMC: 38800,
	},

	PROTOCOL: {
		//CONTROL: 0x27FF,
		CONTROL: 0x2729,
		SETTINGS: 0xffff,
		CMC: 0x1200,
		AES67_CONFIG: 0x2809,
		HEARTBEAT: 0xfffe,
	},

	COMMANDS: {
		channelCount: 0x1000,
		deviceInfo: 0x1003,
		deviceName: 0x1002,
		subscription: 0x3010,
		/** Removes subscriptions from a list of rx channels, in one command. */
		subscriptionRemove: 0x3014,
		rxChannelNames: 0x3000,
		txChannelNames: 0x2010,
		txChannelInfo: 0x2000,
		setRxChannelName: 0x3001,
		setTxChannelName: 0x2013,
		setDeviceName: 0x1001,
		deviceSettings: 0x1100,
		setDeviceSettings: 0x1101,

		RESPONSE_DANTE_MODEL: 0x0060, //96,
		REQUEST_DANTE_MODEL: 0x0061, //97,
		RESPONSE_MAKE_MODEL: 0x00c0, //192,
		REQUEST_MAKE_MODEL: 0x00c1, //193,

		MESSAGE_TYPE_CHANNEL_COUNTS_QUERY: 0x1000, //4096,
		MESSAGE_TYPE_NAME_CONTROL: 0x1001, //4097,
		MESSAGE_TYPE_NAME_QUERY: 0x1002, //4098,
		MESSAGE_TYPE_DEVICE_CONTROL: 0x1003, //4099,
		MESSAGE_TYPE_IDENTIFY_DEVICE_QUERY: 0x10ce, //4302,
		MESSAGE_TYPE_DEVICE_SETTINGS_QUERY: 0x1100,
		MESSAGE_TYPE_DEVICE_SETTINGS_CONTROL: 0x1101,
		MESSAGE_TYPE_TX_CHANNEL_QUERY: 0x2000, //8192,
		MESSAGE_TYPE_TX_CHANNEL_FRIENDLY_NAMES_QUERY: 0x2010, //8208,
		MESSAGE_TYPE_TX_CHANNEL_NAMES_CONTROL: 0x2013,
		MESSAGE_TYPE_RX_CHANNEL_QUERY: 0x3000, //12288,
		MESSAGE_TYPE_RX_CHANNEL_CONTROL: 0x3001, //12289,

		MESSAGE_TYPE_ACCESS_CONTROL: 177,
		MESSAGE_TYPE_ACCESS_STATUS: 176,
		MESSAGE_TYPE_AES67_CONTROL: 4102,
		MESSAGE_TYPE_AES67_STATUS: 4103,
		MESSAGE_TYPE_AUDIO_INTERFACE_QUERY: 135,
		MESSAGE_TYPE_AUDIO_INTERFACE_STATUS: 134,
		MESSAGE_TYPE_CLEAR_CONFIG_CONTROL: 119,
		MESSAGE_TYPE_CLEAR_CONFIG_STATUS: 120,
		MESSAGE_TYPE_CLOCKING_CONTROL: 33,
		MESSAGE_TYPE_CLOCKING_STATUS: 32,
		MESSAGE_TYPE_CODEC_CONTROL: 0x100a, //4106,
		MESSAGE_TYPE_CODEC_STATUS: 0x100b, //4107,
		MESSAGE_TYPE_CONFIG_CONTROL: 115,
		MESSAGE_TYPE_DDM_ENROLMENT_CONFIG_CONTROL: 65286,
		MESSAGE_TYPE_DDM_ENROLMENT_CONFIG_STATUS: 65287,
		MESSAGE_TYPE_DEVICE_REBOOT: 146,
		MESSAGE_TYPE_EDK_BOARD_CONTROL: 161,
		MESSAGE_TYPE_EDK_BOARD_STATUS: 160,
		MESSAGE_TYPE_ENCODING_CONTROL: 0x0083, //131
		MESSAGE_TYPE_ENCODING_STATUS: 0x0082, //130
		MESSAGE_TYPE_HAREMOTE_CONTROL: 4097,
		MESSAGE_TYPE_HAREMOTE_STATUS: 4096,
		MESSAGE_TYPE_IDENTIFY_QUERY: 99,
		MESSAGE_TYPE_IDENTIFY_STATUS: 98,
		MESSAGE_TYPE_IFSTATS_QUERY: 65,
		MESSAGE_TYPE_IFSTATS_STATUS: 64,
		MESSAGE_TYPE_IGMP_VERS_CONTROL: 81,
		MESSAGE_TYPE_IGMP_VERS_STATUS: 80,
		MESSAGE_TYPE_INTERFACE_CONTROL: 19,
		MESSAGE_TYPE_INTERFACE_STATUS: 17,
		MESSAGE_TYPE_LED_QUERY: 209,
		MESSAGE_TYPE_LED_STATUS: 208,
		MESSAGE_TYPE_LOCK_QUERY: 4104,
		MESSAGE_TYPE_LOCK_STATUS: 4105,
		MESSAGE_TYPE_MANF_VERSIONS_QUERY: 0x00c1, //193,
		MESSAGE_TYPE_MANF_VERSIONS_STATUS: 0x00c0, //192,
		MESSAGE_TYPE_MASTER_QUERY: 35,
		MESSAGE_TYPE_MASTER_STATUS: 34,
		MESSAGE_TYPE_METERING_CONTROL: 225,
		MESSAGE_TYPE_METERING_STATUS: 224,
		MESSAGE_TYPE_NAME_ID_CONTROL: 39,
		MESSAGE_TYPE_NAME_ID_STATUS: 38,
		MESSAGE_TYPE_PROPERTY_CHANGE: 0x0106, //262,
		MESSAGE_TYPE_ROUTING_DEVICE_CHANGE: 0x0120, //288,
		MESSAGE_TYPE_ROUTING_READY: 0x0100, //256,
		MESSAGE_TYPE_RX_CHANNEL_CHANGE: 0x0102, //258,
		MESSAGE_TYPE_RX_CHANNEL_RX_ERROR_QUERY: 0x0111, //273,
		MESSAGE_TYPE_RX_CHANNEL_RX_ERROR_STATUS: 0x0110, //272,
		MESSAGE_TYPE_RX_ERROR_THRESHOLD_CONTROL: 0x0113, //275,
		MESSAGE_TYPE_RX_ERROR_THRESHOLD_STATUS: 0x0112, //274,
		MESSAGE_TYPE_RX_FLOW_CHANGE: 0x0105, //261,
		MESSAGE_TYPE_SAMPLE_RATE_CONTROL: 0x0081, //129,
		MESSAGE_TYPE_SAMPLE_RATE_STATUS: 0x0080, //128,
		MESSAGE_TYPE_SAMPLE_RATE_PULLUP_CONTROL: 0x0085, //133,
		MESSAGE_TYPE_SAMPLE_RATE_PULLUP_STATUS: 0x0084, //132,
		MESSAGE_TYPE_SERIAL_PORT_CONTROL: 241,
		MESSAGE_TYPE_SERIAL_PORT_STATUS: 240,
		MESSAGE_TYPE_SWITCH_VLAN_CONTROL: 21,
		MESSAGE_TYPE_SWITCH_VLAN_STATUS: 20,
		MESSAGE_TYPE_SYS_RESET: 144,
		MESSAGE_TYPE_TOPOLOGY_CHANGE: 16,
		MESSAGE_TYPE_TX_CHANNEL_CHANGE: 0x0101, //257,
		MESSAGE_TYPE_TX_FLOW_CHANGE: 0x0104, //260,
		MESSAGE_TYPE_TX_LABEL_CHANGE: 0x0103, //259,
		MESSAGE_TYPE_UNICAST_CLOCKING_CONTROL: 37,
		MESSAGE_TYPE_UNICAST_CLOCKING_STATUS: 36,
		MESSAGE_TYPE_UPGRADE_CONTROL: 113,
		MESSAGE_TYPE_UPGRADE_STATUS: 112,
		MESSAGE_TYPE_VERSIONS_QUERY: 97,
		MESSAGE_TYPE_VERSIONS_STATUS: 96,
	},

	/**
	 * Rx channel subscription status, from offset 14 of an rx channel record.
	 *
	 * Verified against hardware (NAM-262de4, TAV-MINEOLA22XLR) with routes live in Dante Controller:
	 * an unrouted channel reports 0, a cross-device unicast route 9, a cross-device multicast route
	 * 10, and a channel routed back to its own device 4 - in both the forms a self-route can take,
	 * where the reported source device is either the '.' shorthand or the device's own name.
	 *
	 * Note that the separate status at offset 12 is 0x0301 for the working cross-device route but
	 * 0x0000 for the working self-routes, so it is not a usable "is connected" signal.
	 */
	SUBSCRIPTION_STATUS: {
		NONE: 0x0000,
		/** Routed to a transmit channel on the same device; no network flow is involved. */
		CONNECTED_SELF: 0x0004,
		CONNECTED_UNICAST: 0x0009,
		CONNECTED_MULTICAST: 0x000a,
		/**
		 * Carried over from the original module. Never observed on the hardware tested here, and
		 * absent from the netaudio reference catalogue, but kept so whatever prompted its inclusion
		 * does not regress.
		 */
		CONNECTED_UNVERIFIED: 0x000e,
	},

	/** Encoding codes, as reported by the device. Keys are the codes themselves. */
	ENCODINGS: {
		16: 'PCM16',
		24: 'PCM24',
		32: 'PCM32',
	} as Record<EncodingCode, string>,

	/** Output level codes. */
	LEVELS: {
		1: '+18dBu',
		2: '+4dBu',
		3: '+0dBu',
		4: '0dBV',
		5: '-10dBV',
	} as Record<LevelCode, string>,

	/** Sample rate pullup codes. */
	PULLUPS: {
		0: 'NONE',
		1: '+4,1667%',
		2: '+0.1%',
		3: '-0.1%',
		4: '-4%',
	} as Record<PullupCode, string>,
} as const

/**
 * The label for a code a device reported, or undefined when it is not one this module knows.
 *
 * The code maps are keyed by literal unions so their choice ids are precise, which means a raw
 * number off the wire cannot index them directly - a device is free to report a code we have no
 * label for.
 */
export function codeLabel<Key extends string | number>(map: Record<Key, string>, code: number): string | undefined {
	return Object.prototype.hasOwnProperty.call(map, code) ? map[code as Key] : undefined
}

/** Converts a plain `{ id: label }` map into a Companion dropdown `choices` array. */
export function object2choices<Key extends string | number>(obj: Record<Key, string>): DropdownChoice<`${Key}`>[] {
	const choices: DropdownChoice<`${Key}`>[] = []
	// Object.entries stringifies numeric keys, so the ids are the string form of the code
	for (const [id, label] of Object.entries(obj) as [`${Key}`, string][]) {
		choices.push({ id, label })
	}
	return choices
}

/** Like {@link object2choices}, but only includes entries whose id is present in `optionsArray`. */
export function object2PartialChoices<Key extends string | number>(
	obj: Record<Key, string>,
	optionsArray: (string | number)[] | undefined,
): DropdownChoice<`${Key}`>[] {
	const choices: DropdownChoice<`${Key}`>[] = []
	for (const [id, label] of Object.entries(obj) as [`${Key}`, string][]) {
		if (optionsArray?.includes(id)) {
			choices.push({ id, label })
		}
	}
	return choices
}

/**
 * Converts an array of raw values into a Companion dropdown `choices` array, or `undefined` if `array` is nullish.
 */
export function array2choices<T extends string | number>(
	array: T[] | undefined,
	mapping?: (value: T) => string,
): DropdownChoice<T>[] | undefined {
	return array?.map((e) => {
		return { id: e, label: mapping ? mapping(e) : String(e) }
	})
}

/**
 * Subscription status codes that mean audio is actually reaching the receive channel.
 *
 * See {@link DANTE_CONST.SUBSCRIPTION_STATUS} for how these were established.
 */
export const SUBSCRIPTION_STATUS_CONNECTED: readonly number[] = [
	DANTE_CONST.SUBSCRIPTION_STATUS.CONNECTED_SELF,
	DANTE_CONST.SUBSCRIPTION_STATUS.CONNECTED_UNICAST,
	DANTE_CONST.SUBSCRIPTION_STATUS.CONNECTED_MULTICAST,
	DANTE_CONST.SUBSCRIPTION_STATUS.CONNECTED_UNVERIFIED,
]

/** True if `status` (rx record offset 14) indicates a live subscription. */
export function isSubscriptionConnected(status: number | undefined): boolean {
	return status !== undefined && SUBSCRIPTION_STATUS_CONNECTED.includes(status)
}

/** Longest name a Dante device accepts, for both device and channel names. */
export const DANTE_NAME_MAX_LENGTH = 31

/**
 * Checks a name against the rules Dante devices enforce, returning why it is invalid or
 * `undefined` if it is acceptable.
 *
 * Devices silently reject a malformed name, so without this a user just sees nothing happen.
 * Rules mirror the netaudio reference implementation: at most 31 characters, ASCII letters,
 * digits and hyphens only, and no leading or trailing hyphen. Channel names may additionally
 * contain a colon, which separates a channel from its device in subscription strings.
 *
 * An empty name is accepted here because the module uses it to mean "reset to default".
 */
export function validateDanteName(name: string, options: { allowColon?: boolean } = {}): string | undefined {
	if (name === '') {
		return undefined
	}
	if (name.length > DANTE_NAME_MAX_LENGTH) {
		return `must be ${DANTE_NAME_MAX_LENGTH} characters or fewer (got ${name.length})`
	}

	const allowed = options.allowColon ? /^[A-Za-z0-9:-]+$/ : /^[A-Za-z0-9-]+$/
	if (!allowed.test(name)) {
		return options.allowColon
			? 'may only contain letters, digits, hyphens and colons'
			: 'may only contain letters, digits and hyphens'
	}

	const edges = options.allowColon ? ['-', ':'] : ['-']
	for (const edge of edges) {
		if (name.startsWith(edge) || name.endsWith(edge)) {
			return `may not start or end with '${edge}'`
		}
	}

	return undefined
}
