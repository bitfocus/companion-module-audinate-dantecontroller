const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const test = require('node:test')

function loadApiWithMdnsFactory(factory) {
	const mdnsPath = require.resolve('multicast-dns')
	const apiPath = require.resolve('../src/api')
	require('multicast-dns')
	const originalMdns = require.cache[mdnsPath].exports

	require.cache[mdnsPath].exports = factory
	delete require.cache[apiPath]
	const api = require('../src/api')

	return {
		api,
		restore() {
			require.cache[mdnsPath].exports = originalMdns
			delete require.cache[apiPath]
		},
	}
}

test('restarts only mDNS discovery after a socket error', (t) => {
	const sockets = []
	const { api, restore } = loadApiWithMdnsFactory(() => {
		const socket = new EventEmitter()
		socket.destroyed = false
		socket.destroy = () => {
			socket.destroyed = true
		}
		sockets.push(socket)
		return socket
	})
	t.after(restore)

	const originalSetTimeout = global.setTimeout
	const originalClearTimeout = global.clearTimeout
	let scheduled
	global.setTimeout = (callback, delay) => {
		scheduled = { callback, delay }
		return 'restart-timer'
	}
	global.clearTimeout = () => {}
	t.after(() => {
		global.setTimeout = originalSetTimeout
		global.clearTimeout = originalClearTimeout
	})

	const logs = []
	const instance = {
		config: { ip: '192.0.2.10' },
		log: (level, message) => logs.push({ level, message }),
		dante_discovery: () => {},
		getMdnsServices: () => {},
		initMdns: api.initMdns,
		MDNS_RESTART_TIMEOUT: null,
		mdns: null,
	}

	api.initMdns.call(instance, ['192.0.2.10'])
	const firstSocket = sockets[0]
	firstSocket.emit('error', new Error('address already in use'))

	assert.equal(firstSocket.destroyed, true)
	assert.equal(instance.mdns, null)
	assert.equal(instance.MDNS_RESTART_TIMEOUT, 'restart-timer')
	assert.equal(scheduled.delay, 5000)
	assert.deepEqual(logs, [
		{
			level: 'error',
			message: 'mDNS discovery error: address already in use. Restarting in 5s.',
		},
	])

	scheduled.callback()
	assert.equal(sockets.length, 2)
	assert.equal(instance.mdns, sockets[1])
})
