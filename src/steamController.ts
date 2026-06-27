export class SteamController {
  private devices: any[] = [];
  private activeChannels = new Set<{channel: number, freq: number}>();
  private pulseInterval: any = null;

  async autoConnect() {
    try {
      const nav = navigator as any;
      if (!nav.hid) return false;
      const paired = await nav.hid.getDevices();
      // Steam Controller Dongle exposes multiple slots. We must broadcast to all of them!
      const targets = paired.filter((d: any) => d.collections?.some((c: any) => c.usagePage === 0xFF00));
      
      if (targets.length > 0) {
        this.devices = targets;
        for (const device of this.devices) {
          if (!device.opened) {
            try { await device.open(); } catch (e) {}
          }
          device.addEventListener('inputreport', this.handleReport.bind(this));
        }
        return true;
      }
      
      // Fallback
      if (paired.length > 0) {
        this.devices = [paired[0]];
        if (!this.devices[0].opened) await this.devices[0].open();
        this.devices[0].addEventListener('inputreport', this.handleReport.bind(this));
        return true;
      }
    } catch(err) {}
    return false;
  }

  public isCharging: boolean | null = null;
  public batteryPercent: number = 0;
  public batteryVoltage: number = 0;
  public signalStrength: number = 0;
  private hasProbed: boolean = false;

  private handleReport(event: any) {
    const data = new Uint8Array(event.data.buffer);
    
    // In WebHID, event.data DOES NOT include the report ID.
    // If hid-steam.c says data[0] == 1, data[1] == 0, data[2] == 0x04
    // Then in WebHID, event.reportId == 1, data[0] == 0, data[1] == 0x04
    
    if (event.reportId === 67) {
      // Extract signal strength from data[2] (just an assumption from the payload)
      this.signalStrength = data[2];
      
      // Report ID 67 ('C') is the Triton System Status report
      const batt = data[1];
      const volts = data[4] | (data[5] << 8);
      
      this.batteryPercent = batt;
      this.batteryVoltage = volts;
      
      // On first valid voltage reading, probe for charging state
      if (!this.hasProbed && volts > 0) {
        this.hasProbed = true;
        // Query SETTING_DEVICE_POWER_STATUS (register 0x4E = 78) via
        // ID_GET_SETTINGS_VALUES (0x89) feature report
        for (const d of this.devices) {
          if (d.opened) {
            try {
              const payload = new Uint8Array(64);
              payload[0] = 0x4E; // SETTING_DEVICE_POWER_STATUS register
              d.sendFeatureReport(0x89, payload).then(() => {
                // The response should come back as an input report
                // Report 121 handler will pick it up
              }).catch(() => {});
            } catch (_) {}
          }
        }
      }
    }
    
    if (event.reportId === 121) {
      // ID: 121 -> data[0] is the charging status
      // 02 = Charging
      if (data[0] === 2) {
        this.isCharging = true;
      } else {
        this.isCharging = false;
      }
    }
  }

  async connect() {
    try {
      const nav = navigator as any;
      if (!nav.hid) return false;
      
      const selected = await nav.hid.requestDevice({
        filters: [{ vendorId: 0x28de }]
      });
      if (selected.length === 0) return false;
      
      // We must get ALL paired devices, because the dongle presents multiple interfaces
      // and we need to broadcast to all valid ones.
      return this.autoConnect();
    } catch (err) {
      console.error(err);
      return false;
    }
  }

  private startPulsing() {
    if (this.pulseInterval) return;
    this.pulseInterval = setInterval(() => {
      this.activeChannels.forEach(c => this._sendPulse(c.channel, c.freq));
    }, 50); // pulse every 50ms
  }

  // frequency in Hz
  async pulse(channel: number, frequency: number) {
    if (this.devices.length === 0) return;
    
    // Remove old frequency for this channel if exists
    for (const c of this.activeChannels) {
      if (c.channel === channel) this.activeChannels.delete(c);
    }
    
    this.activeChannels.add({ channel, freq: frequency });
    this.startPulsing();
    await this._sendPulse(channel, frequency);
  }

  async stop(channel: number) {
    if (this.devices.length === 0) return;
    
    for (const c of this.activeChannels) {
      if (c.channel === channel) this.activeChannels.delete(c);
    }
    
    if (this.activeChannels.size === 0 && this.pulseInterval) {
      clearInterval(this.pulseInterval);
      this.pulseInterval = null;
    }

    const mappedChannel = channel < 2 ? (!channel ? 4 : 3) : channel - 2;
    
    // Stop Triton Controller (2026) using report 0x83 with 0 gain/frequency
    const data83 = new Uint8Array(9);
    data83[0] = mappedChannel;
    // The rest of data83 is 0 by default, stopping the rumble
    for (const d of this.devices) {
      if (d.opened) {
        try { await d.sendReport(0x83, data83); } catch (e) {}
      }
    }

    // Stop Original Steam Controller Trackpads (channel 0, 1) - report 129 (0x81)
    const data81 = new Uint8Array(7);
    data81[0] = mappedChannel;
    for (const d of this.devices) {
      if (d.opened) {
        try { await d.sendReport(0x81, data81); } catch (e) {}
      }
    }
    
    // Stop Original Steam Controller Rumble (channel 0, 1) - report 143 (0x8F)
    const data8F = new Uint8Array(63);
    data8F[1] = channel;
    data8F[7] = 0x80;
    for (const d of this.devices) {
      if (d.opened) {
        try { await d.sendReport(0x8F, data8F); } catch (e) {}
      }
    }
  }

  async stopAll() {
    for (let i = 0; i < 4; i++) {
      await this.stop(i);
    }
  }

  private async _sendPulse(channel: number, frequency: number) {
    const mappedChannel = channel < 2 ? (!channel ? 4 : 3) : channel - 2;
    const gainByte = (200 - 128) & 255; // 72 for max
    
    // Triton Controller (2026) uses report 0x83
    const data83 = new Uint8Array(9);
    data83[0] = mappedChannel; 
    data83[1] = gainByte; 
    data83[2] = frequency & 0xFF;
    data83[3] = (frequency >> 8) & 0xFF;
    data83[4] = 0xFF;
    data83[5] = 0x7F;
    for (const d of this.devices) {
      if (d.opened) {
        try { await d.sendReport(0x83, data83); } catch (e) {}
      }
    }

    // Fallback: Original Steam Controller (2015) uses report 0x8F
    // It expects period
    const periodCommand = Math.floor(495483.0 / frequency);
    const data8F = new Uint8Array(63);
    data8F[1] = channel; // 0 for Right, 1 for Left
    data8F[2] = periodCommand & 0xFF;
    data8F[3] = (periodCommand >> 8) & 0xFF;
    data8F[4] = periodCommand & 0xFF;
    data8F[5] = (periodCommand >> 8) & 0xFF;
    data8F[6] = 0xFF;
    data8F[7] = 0x7F;
    for (const d of this.devices) {
      if (d.opened) {
        try { await d.sendReport(0x8F, data8F); } catch (e) {}
      }
    }
  }
}
