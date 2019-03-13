import {
	Conductor,
	DeviceType,
	ConductorOptions,
	Device,
	TimelineContentObject,
	TriggerType,
	TimelineTriggerTimeResult,
	DeviceOptions,
	Mappings,
	DeviceContainer
} from 'timeline-state-resolver'
import { CoreHandler, CoreTSRDeviceHandler } from './coreHandler'
let clone = require('fast-clone')
import * as crypto from 'crypto'

import * as _ from 'underscore'
import { CoreConnection, PeripheralDeviceAPI as P, CollectionObj } from 'tv-automation-server-core-integration'
import { LoggerInstance } from './index'

export interface TSRConfig {
}
export interface TSRSettings { // Runtime settings from Core
	devices: {
		[deviceId: string]: DeviceOptions
	}
	initializeAsClear: boolean
	mappings: Mappings
	multiThreading?: boolean
	multiThreadedResolver?: boolean
}
export interface TSRDevice {
	coreConnection: CoreConnection
	device: Device
}
export interface TimelineObj { // interface from Core
	_id: string
	siId?: string
	sliId?: string
	roId: string

	trigger: {
		type: TriggerType
		value: number | string
	}
	duration: number | string
	LLayer: string | number
	content: {
		type: string // TimelineContentType
		[key: string]: any // *other attributes*
	}
	classes?: Array<string>
	disabled?: boolean
	isGroup?: boolean
	inGroup?: string
	repeating?: boolean
	priority?: number
	externalFunction?: string

	/** Only set to true for the "magic" statistic objects, used to trigger playout */
	statObject?: boolean
	/** Only set to true for the test recording objects, to persist outside of a rundown */
	recordingObject?: boolean
}
export interface TimelineContentObjectTmp extends TimelineContentObject {
	inGroup?: string
}
/**
 * Represents a connection between Gateway and TSR
 */
export class TSRHandler {
	logger: LoggerInstance
	tsr: Conductor
	private _config: TSRConfig
	private _coreHandler: CoreHandler
	private _triggerupdateTimelineTimeout: any = null
	private _triggerupdateMappingTimeout: any = null
	private _triggerupdateDevicesTimeout: any = null
	private _coreTsrHandlers: {[deviceId: string]: CoreTSRDeviceHandler} = {}
	private _observers: Array<any> = []
	private _cachedStudioInstallationId: string = ''

	private _initialized: boolean = false
	private _multiThreaded: boolean | null = null

	constructor (logger: LoggerInstance) {
		this.logger = logger
	}

	public init (config: TSRConfig, coreHandler: CoreHandler): Promise<any> {

		this._config = config
		this._coreHandler = coreHandler

		this._coreHandler.setTSR(this)

		this._config = this._config // ts-lint: not used fix
		this.logger.info('TSRHandler init')

		return coreHandler.core.getPeripheralDevice()
		.then((peripheralDevice) => {
			let settings: TSRSettings = peripheralDevice.settings || {}

			this.logger.info('Devices', settings.devices)
			let c: ConductorOptions = {
				getCurrentTime: (): number => {
					return this._coreHandler.core.getCurrentTime()
				},
				initializeAsClear: (settings.initializeAsClear !== false),
				multiThreadedResolver : settings.multiThreadedResolver === true
			}
			this.tsr = new Conductor(c)
			this._triggerupdateMapping()
			this._triggerupdateTimeline()

			coreHandler.onConnected(() => {
				this.setupObservers()
			})
			this.setupObservers()

			this.tsr.on('error', (e, ...args) => {
				// CasparCG play and load 404 errors should be warnings:
				let msg: string = e + ''
				// let cmdInfo: string = args[0] + ''
				let cmdReply = args[0]

				if (
					msg.match(/casparcg/i) &&
					(
						msg.match(/PlayCommand/i) ||
						msg.match(/LoadbgCommand/i)
					) &&
					cmdReply &&
					_.isObject(cmdReply) &&
					cmdReply.response &&
					cmdReply.response.code === 404
				) {
					this.logger.warn('TSR', e, ...args)
				} else {
					this.logger.error('TSR', e, ...args)
				}
			})
			this.tsr.on('info', (msg, ...args) => {
				this.logger.info('TSR', msg, ...args)
			})
			this.tsr.on('warning', (msg, ...args) => {
				this.logger.warn('TSR', msg, ...args)
			})
			this.tsr.on('debug', (...args: any[]) => {
				if (this._coreHandler.logDebug) {
					let msg: any = {
						message: 'TSR debug message (' + args.length + ')',
						data: []
					}
					if (args.length) {
						_.each(args, (arg) => {
							if (_.isObject(arg)) {
								msg.data.push(JSON.stringify(arg))
							} else {
								msg.data.push(arg)
							}
						})
					} else {
						msg.data.push('>empty message<')
					}

					this.logger.debug(msg)
				}
			})

			this.tsr.on('command', (id: string, cmd: any) => { // This is an deprecated event emitter, to be removed soon
				if (this._coreHandler.logDebug) {
					this.logger.info('TSR: Command', { device: id, cmdName: cmd.constructor ? cmd.constructor.name : undefined, cmd: JSON.parse(JSON.stringify(cmd)) })
				}
			})

			this.tsr.on('setTimelineTriggerTime', (r: TimelineTriggerTimeResult) => {
				this.logger.debug('setTimelineTriggerTime')
				this._coreHandler.core.callMethod(P.methods.timelineTriggerTime, [r])
				.catch((e) => {
					this.logger.error('Error in setTimelineTriggerTime', e)
				})
			})
			this.tsr.on('timelineCallback', (time, objId, callbackName, data) => {
				const method = P.methods[callbackName]
				if (method) {
					this._coreHandler.core.callMethod(method, [Object.assign({}, data, {
						objId: objId,
						time: time
					})])
					.catch((e) => {
						this.logger.error('Error in timelineCallback', e)
					})
				} else {
					this.logger.error(`Unknown callback method "${callbackName}"`)
				}

			})

			this.logger.debug('tsr init')
			return this.tsr.init()
		})
		.then(() => {
			this._initialized = true
			this._triggerupdateMapping()
			this._triggerupdateTimeline()
			this._triggerupdateDevices()
			this.onSettingsChanged()
			this.logger.debug('tsr init done')

		})

	}
	setupObservers () {
		if (this._observers.length) {
			this.logger.debug('Clearing observers..')
			this._observers.forEach((obs) => {
				obs.stop()
			})
			this._observers = []
		}
		this.logger.debug('Renewing observers')

		let timelineObserver = this._coreHandler.core.observe('timeline')
		timelineObserver.added = () => { this._triggerupdateTimeline() }
		timelineObserver.changed = () => { this._triggerupdateTimeline() }
		timelineObserver.removed = () => { this._triggerupdateTimeline() }
		this._observers.push(timelineObserver)

		let mappingsObserver = this._coreHandler.core.observe('studioInstallation')
		mappingsObserver.added = () => { this._triggerupdateMapping() }
		mappingsObserver.changed = () => { this._triggerupdateMapping() }
		mappingsObserver.removed = () => { this._triggerupdateMapping() }
		this._observers.push(mappingsObserver)

		let deviceObserver = this._coreHandler.core.observe('peripheralDevices')
		deviceObserver.added = () => { this._triggerupdateDevices() }
		deviceObserver.changed = () => { this._triggerupdateDevices() }
		deviceObserver.removed = () => { this._triggerupdateDevices() }
		this._observers.push(deviceObserver)

	}
	destroy (): Promise<void> {
		return this.tsr.destroy()
	}
	getTimeline (excludeStatObj?: boolean): Array<CollectionObj> | null {
		let siId = this._getStudioInstallationId()
		if (!siId) {
			this.logger.warn('no studioInstallationId')
			return null
		}

		let objs = this._coreHandler.core.getCollection('timeline').find((o: TimelineObj) => {
			if (excludeStatObj) {
				if (o.statObject) return false
			}
			return o.siId === siId
		})

		return objs
	}
	getMapping () {
		let studioInstallation = this._getStudioInstallation()
		if (studioInstallation) {
			return studioInstallation.mappings
		}
		return null
	}
	onSettingsChanged (): void {
		if (!this._initialized) return

		if (this.tsr.logDebug !== this._coreHandler.logDebug) {
			this.logger.info(`Log settings: ${this._coreHandler.logDebug}`)
			this.tsr.logDebug = this._coreHandler.logDebug
		}

		if (this._multiThreaded !== this._coreHandler.multithreading) {
			this._multiThreaded = this._coreHandler.multithreading

			this.logger.info('Multithreading: ' + this._multiThreaded)

			this._updateDevices()
		}

	}
	private _triggerupdateTimeline () {
		if (!this._initialized) return

		if (this._triggerupdateTimelineTimeout) {
			clearTimeout(this._triggerupdateTimelineTimeout)
		}

		let experimentalMessageWaiting = true
		if (experimentalMessageWaiting) {
			/**
			 * In this mode, we're trying a more aggressive strategy to figure out if messages
			 * are still arriving from Core (because we don't want to resolve a partial timeline).
			 * Instead of just waiting a "safe" time, we hijack into the websocket parser to determine
			 * if data is currently arriving.
			 */

			try {

				// @ts-ignore
				let socket: any = this._coreHandler.core._ddp.ddpClient.socket

				if (!socket.setupFakeDriver) {
					socket.setupFakeDriver = true
					socket.receivingMessage = false
					try {

						// @ts-ignore
						let driver = socket._driver

						let orgParse = driver.parse
						driver.parse = function (...args) {

							// This is called when data starts arriving (?)
							socket.receivingMessage = true
							orgParse.call(driver, ...args)
						}

						socket.on('message', () => {

							// The message has been recieved and emitted
							socket.receivingMessage = false
						})
					} catch (e) {
						this.logger.warn('Error in _triggerupdateTimeline (message parsing)', e)
					}
				}

				let time = 0
				let checkIfNotSending = () => {
					if (!socket.receivingMessage) {
						if (time > 2) {
							this._updateTimeline()
							return
						}
					}
					// check again later
					time++
					this._triggerupdateTimelineTimeout = setTimeout(checkIfNotSending, 1)
				}
				this._triggerupdateTimelineTimeout = setTimeout(checkIfNotSending, 1)
				time++
			} catch (e) {
				this.logger.warn(e)

				// Fallback to old way:
				this._triggerupdateTimelineTimeout = setTimeout(() => {
					this._updateTimeline()
				}, 20)
			}
		} else {

			this._triggerupdateTimelineTimeout = setTimeout(() => {
				this._updateTimeline()
			}, 20)
		}
	}
	private _updateTimeline () {
		if (this._determineIfTimelineShouldUpdate()) {
			let transformedTimeline = this._transformTimeline(
				this.getTimeline(true) as Array<TimelineObj>
			)
			if (transformedTimeline) {
				this.tsr.timeline = transformedTimeline
			} else {
				this.logger.warn('Did NOT update Timeline due to an error')
			}
		} else {
			this.logger.debug('_updateTimeline deferring update')
		}
	}
	private _triggerupdateMapping () {
		if (!this._initialized) return
		if (this._triggerupdateMappingTimeout) {
			clearTimeout(this._triggerupdateMappingTimeout)
		}
		this._triggerupdateMappingTimeout = setTimeout(() => {
			this._updateMapping()
			.catch(e => this.logger.error('Error in _updateMapping', e))
		}, 20)
	}
	private async _updateMapping () {
		let mapping = this.getMapping()
		if (mapping) {
			await this.tsr.setMapping(mapping)
		}
	}
	private _getPeripheralDevice () {
		let peripheralDevices = this._coreHandler.core.getCollection('peripheralDevices')
		return peripheralDevices.findOne(this._coreHandler.core.deviceId)
	}
	private _getStudioInstallation (): any | null {
		let peripheralDevice = this._getPeripheralDevice()
		if (peripheralDevice) {
			let studioInstallations = this._coreHandler.core.getCollection('studioInstallation')
			return studioInstallations.findOne(peripheralDevice.studioInstallationId)
		}
		return null
	}
	private _getStudioInstallationId (): string | null {
		if (this._cachedStudioInstallationId) return this._cachedStudioInstallationId

		let studioInstallation = this._getStudioInstallation()
		if (studioInstallation) {
			this._cachedStudioInstallationId = studioInstallation._id
			return studioInstallation._id
		}
		return null
	}
	private _triggerupdateDevices () {
		if (!this._initialized) return
		if (this._triggerupdateDevicesTimeout) {
			clearTimeout(this._triggerupdateDevicesTimeout)
		}
		this._triggerupdateDevicesTimeout = setTimeout(() => {
			this._updateDevices()
		}, 20)
	}
	private _updateDevices () {
		// TODO: rewrite so _addDevice & _removeDevice uses promises
		let peripheralDevices = this._coreHandler.core.getCollection('peripheralDevices')
		let peripheralDevice = peripheralDevices.findOne(this._coreHandler.core.deviceId)

		if (peripheralDevice) {
			let settings: TSRSettings = peripheralDevice.settings || {}

			let devices = settings.devices

			_.each(devices, (deviceOptions: DeviceOptions, deviceId: string) => {

				let oldDevice: DeviceContainer = this.tsr.getDevice(deviceId)

				if (!oldDevice) {
					if (deviceOptions.options) {
						this.logger.info('Initializing device: ' + deviceId)
						this._addDevice(deviceId, deviceOptions)
					}
				} else {
					if (this._multiThreaded !== null && deviceOptions.isMultiThreaded === undefined) {
						deviceOptions.isMultiThreaded = this._multiThreaded
					}
					if (deviceOptions.options) {
						let anyChanged = false

						// let oldOptions = (oldDevice.deviceOptions).options || {}

						if (!_.isEqual(oldDevice.deviceOptions, deviceOptions)) {
							anyChanged = true
						}

						if (anyChanged) {
							this.logger.info('Re-initializing device: ' + deviceId)
							this._removeDevice(deviceId)
							this._addDevice(deviceId, deviceOptions)
						}
					}
				}
			})

			_.each(this.tsr.getDevices(), async (oldDevice: DeviceContainer) => {
				let deviceId = oldDevice.deviceId
				if (!devices[deviceId]) {
					this.logger.info('Un-initializing device: ' + deviceId)
					this._removeDevice(deviceId)
				}
			})
		}
	}
	private _addDevice (deviceId: string, options: DeviceOptions): void {
		this.logger.debug('Adding device ' + deviceId)

		// @ts-ignore
		if (!options.limitSlowSentCommand)		options.limitSlowSentCommand = 40
		// @ts-ignore
		if (!options.limitSlowFulfilledCommand)	options.limitSlowFulfilledCommand = 100

		this.tsr.addDevice(deviceId, options)
		.then(async (device: DeviceContainer) => {
			// set up device status
			const deviceId = device.deviceId
			const deviceType = device.deviceType

			if (!this._coreTsrHandlers[deviceId]) {

				let coreTsrHandler = new CoreTSRDeviceHandler(this._coreHandler, device, this)

				this._coreTsrHandlers[deviceId] = coreTsrHandler

				let onConnectionChanged = (connectedOrStatus: boolean | P.StatusObject) => {
					let deviceStatus: P.StatusObject
					if (_.isBoolean(connectedOrStatus)) { // for backwards compability, to be removed later
						if (connectedOrStatus) {
							deviceStatus = {
								statusCode: P.StatusCode.GOOD
							}
						} else {
							deviceStatus = {
								statusCode: P.StatusCode.BAD,
								messages: ['Disconnected']
							}
						}
					} else {
						deviceStatus = connectedOrStatus
					}
					coreTsrHandler.onConnectionChanged(deviceStatus)
					// hack to make sure atem has media after restart
					if (deviceStatus.statusCode === P.StatusCode.GOOD) {
						// @todo: proper atem media management
						const studioInstallation = this._getStudioInstallation()
						if (deviceType === DeviceType.ATEM && studioInstallation) {
							const ssrcBgs = studioInstallation.config.filter((o) => o._id.substr(0, 18) === 'atemSSrcBackground')
							if (ssrcBgs) {
								try {
									this._coreHandler.uploadFileToAtem(ssrcBgs)
								} catch (e) {
									// don't worry about it.
								}
							}
						}
					}
				}
				let onSlowCommand = (msg: string) => {
					this.logger.warn(msg)
				}
				return coreTsrHandler.init()
				.then(async () => {
					await device.device.on('connectionChanged', onConnectionChanged)
					await device.device.on('slowCommand', onSlowCommand)
					// also ask for the status now, and update:
					onConnectionChanged(await device.device.getStatus())

					return Promise.resolve()
				})
			}
			return Promise.resolve()
		})
		.catch((e) => {
			// TODO: What should we do here?
			// Should we just emit an error, or actually fail the initialization (ie die)?
			this.logger.error(`Error when adding device "${deviceId}"`, e)
		})
	}
	private _removeDevice (deviceId: string) {
		if (this._coreTsrHandlers[deviceId]) {
			this._coreTsrHandlers[deviceId].dispose()
			.catch(e => {
				this.logger.error('Error when removing device: ' + e)
			})
		}
		delete this._coreTsrHandlers[deviceId]
	}
	/**
	 * Go through and transform timeline and generalize the Core-specific things
	 * @param timeline
	 */
	private _transformTimeline (timeline: Array<TimelineObj>): Array<TimelineContentObject> | null {
		// _transformTimeline (timeline: Array<TimelineObj>): Array<TimelineContentObject> | null {

		let transformObject = (obj: TimelineObj): TimelineContentObjectTmp => {
			let transformedObj = clone(_.extend({
				id: obj['_id'],
				roId: obj['roId']
			}, _.omit(obj, ['_id', 'deviceId', 'siId'])))

			if (!transformedObj.content) transformedObj.content = {}
			if (transformedObj.isGroup) {
				if (!transformedObj.content.objects) transformedObj.content.objects = []
			}

			if (obj['slId']) {
				// Will cause a callback to be called, when the object starts to play:
				transformedObj.content.callBack = 'segmentLinePlaybackStarted'
				transformedObj.content.callBackData = {
					roId: obj.roId,
					slId: obj['slId']
				}
				transformedObj.content.callBackStopped = 'segmentLinePlaybackStopped' // Will cause a callback to be called, when the object stops playing:
			}
			if (obj['sliId']) {
				// Will cause a callback to be called, when the object starts to play:
				transformedObj.content.callBack = 'segmentLineItemPlaybackStarted'
				transformedObj.content.callBackData = {
					roId: obj.roId,
					sliId: obj['sliId']
				}
				transformedObj.content.callBackStopped = 'segmentLineItemPlaybackStopped' // Will cause a callback to be called, when the object stops playing:
			}

			return transformedObj
		}

		let objs = timeline
		// First, transform and convert timeline to a key-value store, for fast referencing:
		let objects: {[id: string]: TimelineContentObjectTmp} = {}
		_.each(objs, (obj: TimelineObj) => {
			let transformedObj: TimelineContentObjectTmp = transformObject(obj)
			objects[transformedObj.id] = transformedObj
		})

		// Go through all objects:
		let transformedTimeline: Array<TimelineContentObject> = []
		_.each(objects, (obj: TimelineContentObjectTmp) => {
			if (obj.inGroup) {
				let groupObj = objects[obj.inGroup]
				if (groupObj) {
					// Add object into group:
					if (!groupObj.content.objects) groupObj.content.objects = []
					if (groupObj.content.objects) {
						delete obj.inGroup
						groupObj.content.objects.push(obj)
					}
				} else {
					// referenced group not found
					this.logger.warn('Referenced group "' + obj.inGroup + '" not found! Referenced by "' + obj.id + '"')
				}
			} else {
				// Add object to timeline
				delete obj.inGroup
				transformedTimeline.push(obj)
			}
		})
		return transformedTimeline
	}
	private _determineIfTimelineShouldUpdate (): boolean {

		let requireStatObject: boolean = true // set to false for backwards compability
		let disableStatObject: boolean = false // set to true to disable the statobject check completely

		let pd = this._getPeripheralDevice()
		if (pd && (pd.settings || {}).enableBackwardsCompability) {
			requireStatObject = false
		}
		if (pd && (pd.settings || {}).disableStatObj) {
			disableStatObject = true
		}

		if (disableStatObject) return true

		let siId = this._getStudioInstallationId()
		if (!siId) {
			this.logger.warn('no studioInstallationId')
			return false
		}

		let statObjId = siId + '_statObj'

		let statObject = this._coreHandler.core.getCollection('timeline').find(statObjId)[0]

		if (!statObject) {
			if (requireStatObject) {
				this.logger.info('no statObject')
				return false
			} else {
				return true
			}
		}

		this.logger.info('statObject found')

		let statObjCount 	= (statObject.content || {}).objCount || 0
		let statObjHash 	= (statObject.content || {}).objHash || ''

		// collect statistics
		let objs = this.getTimeline(true)
		if (!objs) return false

		// Number of objects
		let objCount = objs.length
		// Hash of all objects
		objs = objs.sort((a, b) => {
			if (a._id < b._id) return 1
			if (a._id > b._id) return -1
			return 0
		})
		let objHash = getHash(stringifyObjects(objs))

		if (objCount !== statObjCount) {
			this.logger.info('Delaying timeline update, objcount differ (' + objCount + ',' + statObjCount + ') ')
			return false
		}
		if (objHash !== statObjHash) {
			this.logger.info('Delaying timeline update, hash differ (' + objHash + ',' + statObjHash + ') ')
			return false
		}
		return true
	}
}
function stringifyObjects (objs) {
	if (_.isArray(objs)) {
		return _.map(objs, (obj) => {
			return stringifyObjects(obj)
		}).join(',')
	} else if (_.isFunction(objs)) {
		return ''
	} else if (_.isObject(objs)) {
		let keys = _.sortBy(_.keys(objs), (k) => k)

		return _.map(keys, (key) => {
			return key + '=' + stringifyObjects(objs[key])
		}).join(',')
	} else {
		return objs + ''
	}
}

export function getHash (str: string): string {
	const hash = crypto.createHash('sha1')
	return hash.update(str).digest('base64').replace(/[\+\/\=]/g, '_') // remove +/= from strings, because they cause troubles
}
