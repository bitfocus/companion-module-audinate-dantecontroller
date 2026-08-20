import { networkInterfaces } from 'node:os'
import type { DropdownChoice, SomeCompanionConfigField } from '@companion-module/base'

export type ModuleConfig = {
	ip: string
	interval: number
	timeoutInterval: number
	verbose: boolean
}

export function GetConfigFields(): SomeCompanionConfigField[] {
	// get network cards
	const nets = networkInterfaces()
	const nics: Record<string, string[]> = {}
	for (const name of Object.keys(nets)) {
		for (const net of nets[name] ?? []) {
			// Skip over non-IPv4 and internal (i.e. 127.0.0.1) addresses.
			// @types/node still types `family` as the literal 'IPv4'/'IPv6', but on Node 18+ it is
			// actually reported as the number 4 or 6 at runtime - check against whichever this Node returns.
			const familyV4Value: string | number = typeof net.family === 'string' ? 'IPv4' : 4
			if ((net.family as unknown as string | number) === familyV4Value && !net.internal) {
				if (!nics[name]) {
					nics[name] = []
				}
				nics[name].push(net.address)
			}
		}
	}

	const nicChoices: DropdownChoice[] = [{ id: '', label: 'All' }]
	for (const [name, ips] of Object.entries(nics)) {
		for (const ip of ips) {
			nicChoices.push({ id: ip, label: name + ' : ' + ip })
		}
	}

	return [
		{
			type: 'static-text',
			id: 'info',
			width: 12,
			label: 'Information',
			value: 'This module controls Dante devices',
		},

		{
			type: 'dropdown',
			label: 'IP and network card',
			id: 'ip',
			tooltip: 'Choose network card and IP address bound to Dante Controller.',
			width: 12,
			choices: nicChoices,
			default: nicChoices[0]?.id ?? '',
		},

		{
			type: 'number',
			id: 'interval',
			label: 'Update Interval',
			tooltip:
				'Please enter the amount of time in milliseconds to periodically discover new devices. Set to 0 to disable.',
			width: 3,
			default: 1000,
			min: 0,
			max: 3600000,
		},

		{
			type: 'number',
			id: 'timeoutInterval',
			label: 'Timeout Interval',
			tooltip: 'Please enter the time in milliseconds before a device is considered offline. Set to 0 to disable.',
			width: 3,
			default: 3000,
			min: 0,
			max: 3600000,
		},

		{
			type: 'static-text',
			id: 'info2',
			label: 'Verbose Logging',
			width: 12,
			value: `Enabling this option will put more detail in the log, which can be useful for troubleshooting purposes.`,
		},

		{
			type: 'checkbox',
			id: 'verbose',
			label: 'Enable Verbose Logging',
			width: 12,
			default: false,
		},
	]
}
