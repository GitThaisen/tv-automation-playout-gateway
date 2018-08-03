import * as Winston from 'winston'
import { TSRHandler, TSRConfig } from './tsrHandler'
import { CoreHandler, CoreConfig } from './coreHandler'
import { MediaScanner, MediaScannerConfig } from './mediaScanner'
import { LauncherConfig, Launcher } from './launcher'
// import {Conductor, DeviceType} from 'timeline-state-resolver'

export interface Config {
	device: DeviceConfig
	core: CoreConfig
	tsr: TSRConfig
	mediaScanner: MediaScannerConfig
	launcher: LauncherConfig
}
export interface DeviceConfig {
	deviceId: string
	deviceToken: string
}
export class Connector {

	private tsrHandler: TSRHandler
	private coreHandler: CoreHandler
	private mediaScanner: MediaScanner
	private launcher: Launcher
	private _config: Config
	private _logger: Winston.LoggerInstance

	constructor (logger: Winston.LoggerInstance) {
		this._logger = logger
	}

	init (config: Config): Promise<void> {
		this._config = config

		return Promise.resolve()
		.then(() => {
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
			this._logger.info('Initializing Launcher')
			return this.initLauncher()
		})
		.then(() => {
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
	initCore () {
		this.coreHandler = new CoreHandler(this._logger, this._config.device)
		return this.coreHandler.init(this._config.core)
	}
	initTSR (): Promise<void> {
		this.tsrHandler = new TSRHandler(this._logger)
		return this.tsrHandler.init(this._config.tsr, this.coreHandler)

	}
	initMediaScanner (): Promise<void> {
		this.mediaScanner = new MediaScanner(this._logger)

		return this.mediaScanner.init(this._config.mediaScanner, this.coreHandler)

	}
	initLauncher (): Promise<void> {
		this.launcher = new Launcher(this._logger)

		return this.launcher.init(this._config.launcher, this.coreHandler)
	}
}
