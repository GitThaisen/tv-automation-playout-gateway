import { TSRHandler, TSRConfig } from './tsrHandler'
import { CoreHandler, CoreConfig } from './coreHandler'
import { MediaScanner, MediaScannerConfig } from './mediaScanner'
import { LoggerInstance } from './index'
import { Process } from './process'
// import {Conductor, DeviceType} from 'timeline-state-resolver'

export interface Config {
	process: ProcessConfig
	device: DeviceConfig
	core: CoreConfig
	tsr: TSRConfig
	mediaScanner: MediaScannerConfig
}
export interface ProcessConfig {
	/** Will cause the Node applocation to blindly accept all certificates. Not recommenced unless in local, controlled networks. */
	unsafeSSL: boolean
	/** Paths to certificates to load, for SSL-connections */
	certificates: string[]
}
export interface DeviceConfig {
	deviceId: string
	deviceToken: string
}
export class Connector {

	private tsrHandler: TSRHandler
	private coreHandler: CoreHandler
	private mediaScanner: MediaScanner
	private _config: Config
	private _logger: LoggerInstance
	private _process: Process

	constructor (logger: LoggerInstance) {
		this._logger = logger
	}

	init (config: Config): Promise<void> {
		this._config = config

		return Promise.resolve()
		.then(() => {
			this._logger.info('Initializing Process...')
			return this.initProcess()
		})
		.then(() => {
			this._logger.info('Process initialized')
			this._logger.info('Initializing Core...')
			return this.initCore()
		})
		.then(() => {
			this._logger.info('Core initialized')
			this._logger.info('Initializing TSR...')
			return this.initTSR()
		})
		.then(() => {
			this._logger.info('TSR initialized')
			this._logger.info('Initializing Media Scanner...')
			return this.initMediaScanner()
		})
		.then(() => {
			this._logger.info('Media scanner initialized')
			this._logger.info('Initialization done')
			return
		})
		.catch((e) => {
			this._logger.error('Error during initialization:')
			this._logger.error(e)
			this._logger.error(e.stack)

			try {
				if (this.coreHandler) {
					this.coreHandler.destroy()
					.catch(this._logger.error)
				}
				if (this.tsrHandler) {
					this.tsrHandler.destroy()
					.catch(this._logger.error)
				}
			} catch (e) {
				this._logger.error(e)
			}

			this._logger.info('Shutting down in 10 seconds!')
			setTimeout(() => {
				process.exit(0)
			}, 10 * 1000)

			return
		})
	}
	initProcess () {
		this._process = new Process(this._logger)
		this._process.init(this._config.process)
	}
	initCore () {
		this.coreHandler = new CoreHandler(this._logger, this._config.device)
		return this.coreHandler.init(this._config.core, this._process)
	}
	initTSR (): Promise<void> {
		this.tsrHandler = new TSRHandler(this._logger)
		return this.tsrHandler.init(this._config.tsr, this.coreHandler)

	}
	initMediaScanner (): Promise<void> {
		this.mediaScanner = new MediaScanner(this._logger)

		return this.mediaScanner.init(this._config.mediaScanner, this.coreHandler)

	}
}
