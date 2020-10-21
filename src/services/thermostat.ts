import { fetch } from 'cross-fetch';
import { FileSystem } from './filesystem';
import { Platform } from '../platform';
import { IRelaisSwitch, Relais, SwitchTypeEnum } from '../relais/relais';
import { OpenWeatherMapResponse, WeatherInfoService } from './weather-info';

export class Thermostat {
  private platform: Platform;
  private uuid = '6d5b00c42c530b3469b04779146c0b97a723cb2524b60b07e5c327596ebd8f6baebca6bb79a2f1ce24e5a88d7426658a';
  private relais: Relais;
  private weatherInfo: WeatherInfoService;
  private retries = 0;
  private currentForecast: OpenWeatherMapResponse;

  constructor(platform: Platform) {
    this.platform = platform;

    this.platform.logger.debug(`Constructed new instance of Thermostat()`);
    // get initial data from azure
    this.getSensorData();

    this.relais = new Relais(this.platform);
    this.relais.on('update', (switches: IRelaisSwitch[]) => {
      this.platform.config.relais.switches = switches;
    });

    this.weatherInfo = new WeatherInfoService(this.platform);
    this.weatherInfo.on('forecast', (forecast: OpenWeatherMapResponse) => {
      this.platform.logger.log(`Thermostat.weatherInfo.on('forecast')`, forecast);
      this.currentForecast = forecast;
    });

    // set update interval fur current temperature to 1 minute
    setInterval(async () => {
      await this.getSensorData();
    }, 60000);
  }

  async getSensorData() {
    try {
      const result = await fetch(this.sensorUrl);
      const data = (await result.json()) as DeviceReponse;

      this.state.currentTemperature = data.temperature;
      await this.evaluateChanges();
    } catch (err) {
      this.platform.logger.error('error while running getSensorData();', err);
    }
  }

  async evaluateChanges() {
    this.platform.logger.debug('start evaluateChanges()');
    try {
      this.platform.logger.info(`Current temperature: ${this.state.currentTemperature}, target Temperature: ${this.state.targetTemperature}`,
        this.state.targetHeatingCoolingState,
        this.state.currentHeatingCoolingState,
        this.thresholds
      );

      switch (this.state.targetHeatingCoolingState) {
        case HeatingCoolingStateEnum.OFF:
          this.platform.logger.debug('targetHeatingCoolingState is OFF, set current state to OFF');
          this.state.currentHeatingCoolingState = this.state.targetHeatingCoolingState;

          // If any relais is still powered on, turn them off
          this.relais.activate(SwitchTypeEnum.NONE);
          return;

        case HeatingCoolingStateEnum.HEAT:
          this.platform.logger.debug('targetHeatingCoolingState is HEAT, check if currently heating');
          if (this.platform.config.relais.switches.some(e => e.type === SwitchTypeEnum.COOL && e.active)) {
            this.platform.logger.debug('system is currently cooling, turn off COOL');
            this.relais.activate(SwitchTypeEnum.NONE);
          }
          if (this.state.currentHeatingCoolingState === HeatingCoolingStateEnum.HEAT) {
            // The system is currently heating, check if we need to shutdown heater for reaching maximum temperature
            this.platform.logger.debug('Check if target temperature has not been reached');
            if (this.CurrentTemperature >= this.thresholds.heatingMax) {
              this.platform.logger.debug('turn off heating since target has been reached, don\'t change target');
              try {
                this.relais.activate(SwitchTypeEnum.NONE);
                this.state.currentHeatingCoolingState = HeatingCoolingStateEnum.OFF;
                this.retries = 0;
              } catch {
                this.platform.logger.error('Error while turning off the heater, try again next cycle.');
                this.retries++;
              }
            }
          } else if (this.state.currentHeatingCoolingState === HeatingCoolingStateEnum.OFF) {
            this.platform.logger.debug('Check if temperature has dropped below acceptable temperature range');
            if (this.state.currentTemperature <= this.thresholds.heatingMin) {
              this.platform.logger.debug('turn on heating since min target has been reached, don\'t change target');
              try {
                this.relais.activate(SwitchTypeEnum.HEAT);
                this.state.currentHeatingCoolingState = HeatingCoolingStateEnum.HEAT;
                this.retries = 0;
              } catch {
                this.platform.logger.error('Error while turning off the heater, try again next cycle.');
                this.retries++;
              }
            } else if (this.CurrentTemperature <= this.TargetTemperature) {
              this.platform.logger.debug('turn on heating since current temperature is below the target temperature');
              try {
                this.relais.activate(SwitchTypeEnum.HEAT);
                this.state.currentHeatingCoolingState = HeatingCoolingStateEnum.HEAT;
                this.retries = 0;
              } catch {
                this.platform.logger.error('Error while turning off the heater, try again next cycle.');
                this.retries++;
              }
            }
          }
          return;

        case HeatingCoolingStateEnum.COOL:
          this.platform.logger.debug('Target is cooling, check if currently cooling');
          this.relais.activate(SwitchTypeEnum.NONE);
          if (this.state.currentHeatingCoolingState === HeatingCoolingStateEnum.COOL) {
            this.platform.logger.debug('Check if target temperature has been reached');
            if (this.CurrentTemperature <= this.thresholds.coolingMin) {
              this.platform.logger.debug('turn off cooling since target has been reached, don\'t change target');
              try {
                this.relais.activate(SwitchTypeEnum.NONE);
                this.state.currentHeatingCoolingState = HeatingCoolingStateEnum.OFF;
                this.retries = 0;
              } catch {
                this.platform.logger.error('Error while turning off the heater, try again next cycle.');
                this.retries++;
              }
            }
          } else if (this.state.currentHeatingCoolingState === HeatingCoolingStateEnum.OFF) {
            this.platform.logger.debug('check if maximum temperature has been reached');
            if (this.state.currentTemperature >= this.thresholds.coolingMax) {
              this.platform.logger.debug('turn on heating since min target has been reached, don\'t change target');
              try {
                this.relais.activate(SwitchTypeEnum.COOL);
                this.state.currentHeatingCoolingState = HeatingCoolingStateEnum.COOL;
                this.retries = 0;
              } catch {
                this.platform.logger.error('Error while turning off the cooling, try again next cycle.');
                this.retries++;
              }
            }
          }
          return;

        case HeatingCoolingStateEnum.AUTO:
          // this code will be added in the future when we take into account outside weather and time of the year
          return;
      }
    } catch (err) {
      this.platform.logger.error('error while updating relais state', err);
    } finally {
      this.platform.logger.debug(`finished running evaluateChanges()`, 'retries:', this.retries);
      if (this.retries > 5) {
        this.platform.logger.error(`Relais communication has been unsuccessfull 5 Times! Send warning To user to power off master switch`);
      }

      // const writeOk = await new FileSystem().writeFile('./config.json', Buffer.from(JSON.stringify(this.platform.config)));
      // if (writeOk) {
      //   this.platform.logger.debug('successfully saved current state in config');
      // } else {
      //   this.platform.logger.error('Error while trying to save current config to disk!');
      // }
    }
  }

  private get sensorUrl() {
    return `https://simplintho-neo-dev.azurewebsites.net/devices/${this.uuid}`;
  }

  private get thresholds(): HeatingThresholds {
    // calculate min and max HEAT and COOL thresholds based on target temperature.
    // Later we will add integrations with outside temperature, humidity and history
    // cool down and warm up periods and future weather forecast
    return {
      heatingMax: this.TargetTemperature + 1.0,
      heatingMin: this.TargetTemperature - 0.5,
      coolingMax: this.TargetTemperature + 0.5,
      coolingMin: this.TargetTemperature - 1.0
    };
  }

  private get state(): ThermostatState {
    return this.platform.config.thermostatState;
  }

  private set state(value: ThermostatState) {
    this.platform.config.thermostatState = value;
  }

  public get State(): ThermostatState {
    return this.state;
  }

  public get CurrentTemperature(): number {
    return this.state.currentTemperature;
  }

  public get TargetTemperature(): number {
    return this.state.targetTemperature;
  }

  public set TargetTemperature(value: number) {
    this.state.targetTemperature = value;
    this.evaluateChanges();
  }

  public get CurrentHeatingCoolingState(): HeatingCoolingStateEnum {
    return this.state.currentHeatingCoolingState;
  }

  public get TargetHeatingCoolingState(): HeatingCoolingStateEnum {
    return this.state.targetHeatingCoolingState;
  }

  public set TargetHeatingCoolingState(value: HeatingCoolingStateEnum) {
    this.state.targetHeatingCoolingState = value;
    this.evaluateChanges();
  }
}

export interface ThermostatState {
  currentTemperature: number;
  targetTemperature: number;
  currentHeatingCoolingState: HeatingCoolingStateEnum;
  targetHeatingCoolingState: HeatingCoolingStateEnum;
  temperatureDisplayUnits: TemperatureDisplayUnits;
}

export interface HeatingThresholds {
  heatingMin: number;
  heatingMax: number;
  coolingMin: number;
  coolingMax: number;
}

export enum HeatingCoolingStateEnum {
  OFF = 0,
  HEAT = 1,
  COOL = 2,
  AUTO = 3
}

export enum TemperatureDisplayUnits {
  CELSIUS = 0,
  FAHRENHEIT = 1
}

interface DeviceReponse {
  uuid: string;
  name: string;
  mac: string;
  firstSeen: string;
  lastSeen: string;
  localIp?: string;
  ipv4?: string;
  ipv6?: string;
  ownerUuid: string;
  temperature: number;
  humidity: number;
  pressure: number;
  icon: string;
  hwVersion: string;
  fwVersion: string;
  checkUpdates: boolean;
  autoUpdate: boolean;
  logLevel: string;
  hwSupported: boolean;
}
