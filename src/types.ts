import type { CompanionVariableValues } from '@companion-module/base'
import type { ModuleConfig } from './config.js'
import type { ActionSchema } from './actions.js'
import type { FeedbackSchema } from './feedbacks.js'

export interface DanteModuleTypes {
	config: ModuleConfig
	secrets: undefined
	actions: ActionSchema
	feedbacks: FeedbackSchema
	variables: CompanionVariableValues
}
