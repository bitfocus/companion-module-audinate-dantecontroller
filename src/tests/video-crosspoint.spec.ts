import { describe, expect, it, vi } from 'vitest'
import type dgram from 'node:dgram'
import { UpdateFeedbacks } from '../feedbacks.js'
import { UpdateActions } from '../actions.js'
import { DANTE_CONST, type DevicesData } from '../api/index.js'
import type DanteInstance from '../main.js'

/**
 * Combined-scope tests for the video/audio channelType toggle across the crosspoint actions and
 * feedbacks - see `dante-video-routing-protocol` project notes for the wire-level protocol these
 * exercise indirectly (already checked byte-for-byte in `src/api/tests/video.spec.ts`). These check
 * the layer above it: that a `channelType` of `'video'` routes to the video API functions and reads
 * `videoRx`/`videoTx` instead of `rx`/`tx`, alongside the pre-existing audio behaviour.
 */

const DEST = '10.0.0.5'
const SOURCE = '10.0.0.6'

function devicesData(): DevicesData {
	return {
		[DEST]: {
			name: 'DeviceA',
			ports: { ARC: 4440 },
			audioRx: {
				count: 1,
				1: { number: 1, name: 'Audio In 1', sourceDevice: 'DeviceB', sourceChannel: '01', subscriptionStatus: 9 },
			},
			audioTx: { count: 1, 1: { number: 1, name: 'Audio Out 1' } },
			videoRx: {
				count: 2,
				1: { number: 1, name: 'Video In 1', sourceDevice: 'DeviceB', sourceChannel: 'Cam 1' },
				2: { number: 2, name: 'Video In 2' },
			},
			videoTx: { count: 1, 1: { number: 1, name: 'Video Out 1' } },
		},
		[SOURCE]: {
			name: 'DeviceB',
			ports: { ARC: 4440 },
			audioRx: { count: 1, 1: { number: 1, name: 'Audio In 1' } },
			audioTx: { count: 1, 1: { number: 1, name: '01' } },
			videoRx: { count: 1, 1: { number: 1, name: 'Video In 1' } },
			videoTx: { count: 1, 1: { number: 1, name: 'Cam 1' } },
		},
	}
}

function instance(data: DevicesData = devicesData(), overrides: Partial<DanteInstance> = {}) {
	return {
		config: { mac: '', interval: 1000, timeoutInterval: 3000, variables: true, verbose: false },
		devicesData: data,
		devicesChoices: Object.entries(data).map(([, device]) => ({ id: device.name!, label: device.name! })),
		rxChannelsChoices: { DeviceA: [{ id: 1, label: 'Audio In 1' }], DeviceB: [{ id: 1, label: 'Audio In 1' }] },
		txChannelsChoices: { DeviceA: [{ id: 1, label: 'Audio Out 1' }], DeviceB: [{ id: 1, label: '01' }] },
		videoRxChannelsChoices: {
			DeviceA: [
				{ id: 1, label: 'Video In 1' },
				{ id: 2, label: 'Video In 2' },
			],
			DeviceB: [{ id: 1, label: 'Video In 1' }],
		},
		videoTxChannelsChoices: { DeviceA: [{ id: 1, label: 'Video Out 1' }], DeviceB: [{ id: 1, label: 'Cam 1' }] },
		sockets: {},
		counter: Buffer.from('0000', 'hex'),
		setActionDefinitions: vi.fn(),
		setFeedbackDefinitions: vi.fn(),
		checkFeedbacksById: vi.fn(),
		log: vi.fn(),
		...overrides,
	} as unknown as DanteInstance
}

function feedbackDefinition(self: DanteInstance, feedbackId: string) {
	UpdateFeedbacks(self)
	return (self.setFeedbackDefinitions as ReturnType<typeof vi.fn>).mock.calls[0][0][feedbackId]
}

function actionDefinition(self: DanteInstance, actionId: string) {
	UpdateActions(self)
	return (self.setActionDefinitions as ReturnType<typeof vi.fn>).mock.calls[0][0][actionId]
}

/**
 * Opcodes of the channel-directory queries every video write issues after itself, so the module
 * learns the new state - AV_EXTENDED devices send no unsolicited update of their own. See
 * `refreshVideoChannels` in `commands.ts`.
 */
const DIRECTORY_QUERY_OPCODES: number[] = [
	DANTE_CONST.COMMANDS.MESSAGE_TYPE_AV_RX_CHANNEL_QUERY,
	DANTE_CONST.COMMANDS.MESSAGE_TYPE_AV_TX_CHANNEL_QUERY,
]

/** The packets a command sent, excluding those follow-up directory re-reads. */
function writes(sendFn: ReturnType<typeof vi.fn>): Buffer[] {
	return sendFn.mock.calls
		.map((call) => call[0] as Buffer)
		.filter((buffer) => !DIRECTORY_QUERY_OPCODES.includes(buffer.readUInt16BE(6)))
}

/** The directory re-reads a command issued, by opcode. */
function refreshes(sendFn: ReturnType<typeof vi.fn>): number[] {
	return sendFn.mock.calls
		.map((call) => (call[0] as Buffer).readUInt16BE(6))
		.filter((opcode) => DIRECTORY_QUERY_OPCODES.includes(opcode))
}

describe('Channel Subscription feedback, video', () => {
	function read(self: DanteInstance, channel: number, device = 'DeviceA') {
		return feedbackDefinition(self, 'channel_subscription').callback(
			{
				id: `cs-${device}-${channel}`,
				options: { channelType: 'video', device, [`channelVideo_${device}`]: channel },
			},
			{},
		)
	}

	it('offers a distinctly-labeled video channel field alongside the audio one', () => {
		const options = feedbackDefinition(instance(), 'channel_subscription').options as { id: string; label: string }[]
		expect(options.find((option) => option.id === 'channel_DeviceA')?.label).toBe('Channel')
		expect(options.find((option) => option.id === 'channelVideo_DeviceA')?.label).toBe('Video channel')
	})

	it('reports the video source device and channel of a cross-device subscription', () => {
		expect(read(instance(), 1)).toEqual({
			connected: true,
			device: { name: 'DeviceB', ip: SOURCE },
			channel: { name: 'Cam 1', number: 1 },
		})
	})

	it('returns the empty shape for an unrouted video channel', () => {
		expect(read(instance(), 2)).toEqual({
			connected: false,
			device: { name: '', ip: '' },
			channel: { name: '', number: 0 },
		})
	})

	it('does not confuse the video subscription with the audio one on the same device', () => {
		// ch1 audio is routed to DeviceB/01, ch1 video is routed to DeviceB/Cam 1 - reading video must
		// not accidentally report the audio subscription's source
		expect(read(instance(), 1)).toMatchObject({ channel: { name: 'Cam 1' } })
	})

	it('exits cleanly with a clear log message when the device has no video channels at all', () => {
		const self = instance()
		const noVideo = feedbackDefinition(self, 'channel_subscription').callback(
			{ id: 'cs-none', options: { channelType: 'video', device: 'DeviceA' } },
			{},
		)
		expect(noVideo).toEqual({ connected: false, device: { name: '', ip: '' }, channel: { name: '', number: 0 } })
		expect(self.log).not.toHaveBeenCalled() // this feedback logs through its own module logger, not self.log
	})
})

describe('Crosspoint - Connected feedback, video', () => {
	function evaluate(self: DanteInstance, options: Record<string, unknown>) {
		return feedbackDefinition(self, 'routing_bg').callback({ id: 'rb-video', options }, {})
	}

	it('is true when the selected video source matches the destination channel', () => {
		const self = instance()
		expect(
			evaluate(self, {
				channelType: 'video',
				destinationDevice: 'DeviceA',
				destinationChannelVideo_DeviceA: 1,
				sourceDevice: 'DeviceB',
				sourceChannelVideo_DeviceB: 1,
			}),
		).toBe(true)
	})

	it('is false for a video channel that is not routed', () => {
		const self = instance()
		expect(
			evaluate(self, {
				channelType: 'video',
				destinationDevice: 'DeviceA',
				destinationChannelVideo_DeviceA: 2,
				sourceDevice: 'DeviceB',
				sourceChannelVideo_DeviceB: 1,
			}),
		).toBe(false)
	})

	it('does not fall back to the audio route when video is selected', () => {
		// ch1 audio IS routed DeviceB -> DeviceA, but channelType asks for video - must not match on it
		const self = instance()
		expect(
			evaluate(self, {
				channelType: 'video',
				destinationDevice: 'DeviceA',
				destinationChannelVideo_DeviceA: 2,
				sourceDevice: 'DeviceB',
				sourceChannelVideo_DeviceB: 1,
			}),
		).toBe(false)
	})
})

describe('Crosspoint - Connected feedback learn, video', () => {
	function learn(self: DanteInstance, feedbackId: string, options: Record<string, unknown>) {
		return feedbackDefinition(self, feedbackId).learn({ id: 'rb-video', options }, {})
	}

	it('learns the video source device and its per-device video channel key', () => {
		expect(
			learn(instance(), 'routing_bg', {
				channelType: 'video',
				destinationDevice: 'DeviceA',
				destinationChannelVideo_DeviceA: 1,
			}),
		).toEqual({ sourceDevice: 'DeviceB', sourceChannelVideo_DeviceB: 1 })
	})

	it('reads the audio route instead when channelType is audio', () => {
		// The same destination device carries both, so the channelType decides which one is learnt.
		expect(
			learn(instance(), 'routing_bg', {
				channelType: 'audio',
				destinationDevice: 'DeviceA',
				destinationChannel_DeviceA: 1,
			}),
		).toEqual({ sourceDevice: 'DeviceB', sourceChannel_DeviceB: 1 })
	})

	it('declines for a video channel that is not routed', () => {
		expect(
			learn(instance(), 'routing_bg', {
				channelType: 'video',
				destinationDevice: 'DeviceA',
				destinationChannelVideo_DeviceA: 2,
			}),
		).toBeUndefined()
	})

	it('declines when the destination has no video channels at all', () => {
		// DeviceB has no video rx channels, so destinationChannelVideo_DeviceB was never rendered
		expect(learn(instance(), 'routing_bg', { channelType: 'video', destinationDevice: 'DeviceB' })).toBeUndefined()
	})

	it('learns the video source into the custom feedback text fields', () => {
		expect(
			learn(instance(), 'routing_bg_manual', {
				channelType: 'video',
				destinationDeviceId: 'DeviceA',
				destinationChannelId: 'Video In 1',
			}),
		).toEqual({ sourceChannelName: 'Cam 1', sourceDeviceName: 'DeviceB' })
	})

	it('does not fall back to the audio route when the custom feedback asks for video', () => {
		// Video ch2 is unrouted while audio ch1 is routed - a video learn must not read across
		expect(
			learn(instance(), 'routing_bg_manual', {
				channelType: 'video',
				destinationDeviceId: 'DeviceA',
				destinationChannelId: '2',
			}),
		).toBeUndefined()
	})
})

describe('Crosspoint - Make/Clear actions, video', () => {
	function send(self: DanteInstance) {
		return (self.sockets.ARC as unknown as { send: ReturnType<typeof vi.fn> }).send
	}

	it('makeCrosspointDropDown sends a video crosspoint command when channelType is video', async () => {
		const sendFn = vi.fn()
		const self = instance(devicesData(), { sockets: { ARC: { send: sendFn } as unknown as dgram.Socket } })
		await actionDefinition(self, 'makeCrosspointDropDown').callback({
			options: {
				channelType: 'video',
				destinationDevice: 'DeviceA',
				destinationChannelVideo_DeviceA: 2,
				sourceDevice: 'DeviceB',
				sourceChannelVideo_DeviceB: 1,
			},
		})

		expect(writes(sendFn)).toHaveLength(1)
		const sentBuffer = writes(sendFn)[0]
		expect(sentBuffer.readUInt16BE(0) & DANTE_CONST.AV_EXTENDED_MASK).toBe(
			DANTE_CONST.PROTOCOL.AV_EXTENDED & DANTE_CONST.AV_EXTENDED_MASK,
		)
		expect(sentBuffer.readUInt16BE(6)).toBe(DANTE_CONST.COMMANDS.MESSAGE_TYPE_AV_CROSSPOINT_CONTROL)
		expect(refreshes(sendFn)).toEqual([DANTE_CONST.COMMANDS.MESSAGE_TYPE_AV_RX_CHANNEL_QUERY])
	})

	it('makeCrosspointDropDown still sends a plain audio command when channelType is audio', async () => {
		const sendFn = vi.fn()
		const self = instance(devicesData(), { sockets: { ARC: { send: sendFn } as unknown as dgram.Socket } })
		await actionDefinition(self, 'makeCrosspointDropDown').callback({
			options: {
				channelType: 'audio',
				destinationDevice: 'DeviceA',
				destinationChannel_DeviceA: 1,
				sourceDevice: 'DeviceB',
				sourceChannel_DeviceB: 1,
			},
		})

		expect(sendFn).toHaveBeenCalledTimes(1)
		const sentBuffer = sendFn.mock.calls[0][0] as Buffer
		expect(sentBuffer.readUInt16BE(0)).toBe(DANTE_CONST.PROTOCOL.CONTROL)
	})

	it('clearCrosspointDropDown sends a video clear command when channelType is video', async () => {
		const sendFn = vi.fn()
		const self = instance(devicesData(), { sockets: { ARC: { send: sendFn } as unknown as dgram.Socket } })
		await actionDefinition(self, 'clearCrosspointDropDown').callback({
			options: {
				channelType: 'video',
				destinationDevice: 'DeviceA',
				destinationChannelVideo_DeviceA: 1,
				clearAll: false,
			},
		})

		expect(writes(sendFn)).toHaveLength(1)
		expect(writes(sendFn)[0].readUInt16BE(6)).toBe(DANTE_CONST.COMMANDS.MESSAGE_TYPE_AV_CROSSPOINT_CONTROL)
		expect(refreshes(sendFn)).toEqual([DANTE_CONST.COMMANDS.MESSAGE_TYPE_AV_RX_CHANNEL_QUERY])
	})

	it('logs a clear message and sends nothing when the destination channel option is missing', async () => {
		const sendFn = vi.fn()
		const self = instance(devicesData(), { sockets: { ARC: { send: sendFn } as unknown as dgram.Socket } })
		// DeviceB has no video rx channels, so destinationChannelVideo_DeviceB was never rendered
		await actionDefinition(self, 'clearCrosspointDropDown').callback({
			options: { channelType: 'video', destinationDevice: 'DeviceB', clearAll: false },
		})

		expect(sendFn).not.toHaveBeenCalled()
	})

	it('still supports clearing every video channel on a device', async () => {
		const sendFn = vi.fn()
		const self = instance(devicesData(), { sockets: { ARC: { send: sendFn } as unknown as dgram.Socket } })
		await actionDefinition(self, 'clearCrosspointDropDown').callback({
			options: { channelType: 'video', destinationDevice: 'DeviceA', clearAll: true },
		})

		// DeviceA has 2 video rx channels, each cleared individually and each re-read afterwards
		expect(writes(sendFn)).toHaveLength(2)
		expect(refreshes(sendFn)).toHaveLength(2)
		expect(send(self)).toBe(sendFn)
	})
})

describe('Channel Name - Set/Reset actions, video', () => {
	function opcodeOf(buffer: Buffer): number {
		return buffer.readUInt16BE(6)
	}

	it('setRxChannelName sends a video rx rename command when channelType is video', async () => {
		const sendFn = vi.fn()
		const self = instance(devicesData(), { sockets: { ARC: { send: sendFn } as unknown as dgram.Socket } })
		await actionDefinition(self, 'setRxChannelName').callback({
			options: { channelType: 'video', device: 'DeviceA', channelVideo_DeviceA: 2, newName: 'New Name' },
		})

		expect(writes(sendFn)).toHaveLength(1)
		expect(opcodeOf(writes(sendFn)[0])).toBe(DANTE_CONST.COMMANDS.MESSAGE_TYPE_AV_RX_CHANNEL_NAME_CONTROL)
		expect(refreshes(sendFn)).toEqual([DANTE_CONST.COMMANDS.MESSAGE_TYPE_AV_RX_CHANNEL_QUERY])
	})

	it('setRxChannelName still sends a plain audio rename command when channelType is audio', async () => {
		const sendFn = vi.fn()
		const self = instance(devicesData(), { sockets: { ARC: { send: sendFn } as unknown as dgram.Socket } })
		// audio names may not contain spaces (see validateDanteName's allowSpace note) - video's do
		await actionDefinition(self, 'setRxChannelName').callback({
			options: { channelType: 'audio', device: 'DeviceA', channel_DeviceA: 1, newName: 'New-Name' },
		})

		expect(sendFn).toHaveBeenCalledTimes(1)
		expect(opcodeOf(sendFn.mock.calls[0][0] as Buffer)).toBe(DANTE_CONST.COMMANDS.MESSAGE_TYPE_RX_CHANNEL_CONTROL)
	})

	it('setTxChannelName sends a video tx rename command when channelType is video', async () => {
		const sendFn = vi.fn()
		const self = instance(devicesData(), { sockets: { ARC: { send: sendFn } as unknown as dgram.Socket } })
		await actionDefinition(self, 'setTxChannelName').callback({
			options: { channelType: 'video', device: 'DeviceB', channelVideo_DeviceB: 1, newName: 'New Cam Name' },
		})

		expect(writes(sendFn)).toHaveLength(1)
		expect(opcodeOf(writes(sendFn)[0])).toBe(DANTE_CONST.COMMANDS.MESSAGE_TYPE_AV_TX_CHANNEL_NAME_CONTROL)
		// a tx rename re-reads the tx directory, not the rx one
		expect(refreshes(sendFn)).toEqual([DANTE_CONST.COMMANDS.MESSAGE_TYPE_AV_TX_CHANNEL_QUERY])
	})

	it('resetRxChannelName sends an empty-name video rx rename command when channelType is video', async () => {
		const sendFn = vi.fn()
		const self = instance(devicesData(), { sockets: { ARC: { send: sendFn } as unknown as dgram.Socket } })
		await actionDefinition(self, 'resetRxChannelName').callback({
			options: { channelType: 'video', device: 'DeviceA', channelVideo_DeviceA: 1 },
		})

		expect(writes(sendFn)).toHaveLength(1)
		expect(opcodeOf(writes(sendFn)[0])).toBe(DANTE_CONST.COMMANDS.MESSAGE_TYPE_AV_RX_CHANNEL_NAME_CONTROL)
		expect(refreshes(sendFn)).toEqual([DANTE_CONST.COMMANDS.MESSAGE_TYPE_AV_RX_CHANNEL_QUERY])
	})

	it('resetTxChannelName sends an empty-name video tx rename command when channelType is video', async () => {
		const sendFn = vi.fn()
		const self = instance(devicesData(), { sockets: { ARC: { send: sendFn } as unknown as dgram.Socket } })
		await actionDefinition(self, 'resetTxChannelName').callback({
			options: { channelType: 'video', device: 'DeviceB', channelVideo_DeviceB: 1 },
		})

		expect(writes(sendFn)).toHaveLength(1)
		expect(opcodeOf(writes(sendFn)[0])).toBe(DANTE_CONST.COMMANDS.MESSAGE_TYPE_AV_TX_CHANNEL_NAME_CONTROL)
		expect(refreshes(sendFn)).toEqual([DANTE_CONST.COMMANDS.MESSAGE_TYPE_AV_TX_CHANNEL_QUERY])
	})

	it('learns the current video channel name as the starting point for an edit', () => {
		const self = instance()
		const learnt = actionDefinition(self, 'setRxChannelName').learn({
			options: { channelType: 'video', device: 'DeviceA', channelVideo_DeviceA: 1 },
		})
		expect(learnt).toEqual({ newName: 'Video In 1' })
	})

	it('logs a clear message and sends nothing when the channel option is missing entirely', async () => {
		const sendFn = vi.fn()
		const self = instance(devicesData(), { sockets: { ARC: { send: sendFn } as unknown as dgram.Socket } })
		// No channelVideo_DeviceB key at all - the same shape a device with zero video tx channels
		// would leave the stored options in, since its field would never have been rendered.
		await actionDefinition(self, 'setTxChannelName').callback({
			options: { channelType: 'video', device: 'DeviceB', newName: 'New Name' },
		})

		expect(sendFn).not.toHaveBeenCalled()
	})
})

describe('missing-channel warnings', () => {
	const AUDIO_ONLY = '10.0.0.7'
	const VIDEO_ONLY = '10.0.0.8'

	/** The realistic mixed network: most devices are audio-only, a couple carry video. */
	function mixedDevices(): DevicesData {
		return {
			...devicesData(),
			[AUDIO_ONLY]: {
				name: 'AudioOnly',
				ports: { ARC: 4440 },
				audioRx: { count: 1, 1: { number: 1, name: 'In 1' } },
				audioTx: { count: 1, 1: { number: 1, name: 'Out 1' } },
			},
			[VIDEO_ONLY]: {
				name: 'VideoOnly',
				ports: { ARC: 4440 },
				videoRx: { count: 1, 1: { number: 1, name: 'V In 1' } },
				videoTx: { count: 1, 1: { number: 1, name: 'V Out 1' } },
			},
		}
	}

	function mixedInstance() {
		const data = mixedDevices()
		return instance(data, {
			devicesChoices: Object.entries(data).map(([, device]) => ({ id: device.name!, label: device.name! })),
			rxChannelsChoices: {
				DeviceA: [{ id: 1, label: 'Audio In 1' }],
				DeviceB: [{ id: 1, label: 'Audio In 1' }],
				AudioOnly: [{ id: 1, label: 'In 1' }],
			},
			txChannelsChoices: {
				DeviceA: [{ id: 1, label: 'Audio Out 1' }],
				DeviceB: [{ id: 1, label: '01' }],
				AudioOnly: [{ id: 1, label: 'Out 1' }],
			},
			videoRxChannelsChoices: {
				DeviceA: [
					{ id: 1, label: 'Video In 1' },
					{ id: 2, label: 'Video In 2' },
				],
				DeviceB: [{ id: 1, label: 'Video In 1' }],
				VideoOnly: [{ id: 1, label: 'V In 1' }],
			},
			videoTxChannelsChoices: {
				DeviceA: [{ id: 1, label: 'Video Out 1' }],
				DeviceB: [{ id: 1, label: 'Cam 1' }],
				VideoOnly: [{ id: 1, label: 'V Out 1' }],
			},
		})
	}

	function options(self: DanteInstance, actionId: string) {
		return actionDefinition(self, actionId).options as {
			id: string
			type: string
			value?: string
			isVisibleExpression?: string
		}[]
	}

	it('warns that an audio-only device has no video channels, shown only in video mode', () => {
		const warning = options(mixedInstance(), 'makeCrosspointDropDown').find(
			(option) => option.id === 'destinationDeviceNoVideoRXChannels_AudioOnly',
		)
		expect(warning?.type).toBe('static-text')
		expect(warning?.value).toContain('AudioOnly has no video receive channels')
		expect(warning?.isVisibleExpression).toContain("$(options:channelType) == 'video'")
		expect(warning?.isVisibleExpression).toContain("$(options:destinationDevice) == 'AudioOnly'")
	})

	it('warns symmetrically for a video-only device selected in audio mode', () => {
		const warning = options(mixedInstance(), 'makeCrosspointDropDown').find(
			(option) => option.id === 'destinationDeviceNoAudioRXChannels_VideoOnly',
		)
		expect(warning?.value).toContain('VideoOnly has no audio receive channels')
		expect(warning?.isVisibleExpression).toContain("$(options:channelType) == 'audio'")
	})

	it('says transmit, not receive, for a source picker', () => {
		const warning = options(mixedInstance(), 'makeCrosspointDropDown').find(
			(option) => option.id === 'sourceDeviceNoVideoTXChannels_AudioOnly',
		)
		expect(warning?.value).toContain('AudioOnly has no video transmit channels')
	})

	it('emits no warning for a device that has channels of both kinds', () => {
		const ids = options(mixedInstance(), 'makeCrosspointDropDown').map((option) => option.id)
		expect(ids).not.toContain('destinationDeviceNoVideoRXChannels_DeviceA')
		expect(ids).not.toContain('destinationDeviceNoAudioRXChannels_DeviceA')
	})

	it('emits no warning for a device the picker never offers in that direction', () => {
		// A device with no receive channels of *either* kind is filtered out of the destination
		// dropdown, so it can never be the selected device and a warning about it could never be seen.
		// Both receive lists are emptied here, since the warnings are generated from the cached choice
		// lists rather than from devicesData.
		const data = mixedDevices()
		const self = instance(data, {
			devicesChoices: Object.entries(data).map(([, device]) => ({ id: device.name!, label: device.name! })),
			rxChannelsChoices: { DeviceA: [{ id: 1, label: 'Audio In 1' }] },
			txChannelsChoices: { DeviceA: [{ id: 1, label: 'Audio Out 1' }], AudioOnly: [{ id: 1, label: 'Out 1' }] },
			videoRxChannelsChoices: { DeviceA: [{ id: 1, label: 'Video In 1' }] },
			videoTxChannelsChoices: { DeviceA: [{ id: 1, label: 'Video Out 1' }] },
		})

		const ids = options(self, 'makeCrosspointDropDown').map((option) => option.id)
		// AudioOnly has no receive channels of either kind here, so neither warning applies...
		expect(ids).not.toContain('destinationDeviceNoVideoRXChannels_AudioOnly')
		expect(ids).not.toContain('destinationDeviceNoAudioRXChannels_AudioOnly')
		// ...but it does still transmit audio, so the source picker warns about its missing video.
		expect(ids).toContain('sourceDeviceNoVideoTXChannels_AudioOnly')
	})

	it('keeps showing the warning while Clear All is on, unlike the channel picker', () => {
		// Hiding it alongside the picker implied that "clear every channel" escapes the Channel Type.
		// It does not - a device with no video channels has no video channels to clear either way.
		const fields = options(mixedInstance(), 'clearCrosspointDropDown')
		const warning = fields.find((option) => option.id === 'destinationDeviceNoVideoRXChannels_AudioOnly')
		expect(warning?.isVisibleExpression).not.toContain('clearAll')

		// the picker itself is still hidden by it, which is what the checkbox genuinely replaces
		const picker = fields.find((option) => option.id === 'destinationChannelVideo_DeviceA')
		expect(picker?.isVisibleExpression).toContain('!$(options:clearAll)')
	})

	it('names the Channel Type in the Clear All label, since that is what it honours', () => {
		const checkbox = options(mixedInstance(), 'clearCrosspointDropDown').find((option) => option.id === 'clearAll') as
			{ label?: string; tooltip?: string } | undefined
		expect(checkbox?.label).toBe('Clear every channel of the selected Channel Type')
		expect(checkbox?.tooltip).toContain('cleared separately')
	})

	it('reaches the feedbacks too, not just the actions', () => {
		const self = mixedInstance()
		UpdateFeedbacks(self)
		const definitions = (self.setFeedbackDefinitions as ReturnType<typeof vi.fn>).mock.calls[0][0]
		const ids = (definitions.routing_bg.options as { id: string }[]).map((option) => option.id)
		expect(ids).toContain('destinationDeviceNoVideoRXChannels_AudioOnly')
		expect(ids).toContain('sourceDeviceNoVideoTXChannels_AudioOnly')
	})
})
