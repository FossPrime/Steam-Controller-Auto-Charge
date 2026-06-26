# Specification: Triton Controller (2026 Steam Controller)

This document specifies the technical design, protocol characteristics, button layouts, and advanced capabilities of the **Triton Controller (2026 Steam Controller)**, based on the reverse-engineered native libraries and Android Java driver implementation.

---

## 1. Hardware Overview & Connection Modes

The Triton Controller is the 2026 revision of Valve's gaming controller, designed for native integration with Steam Link and Moonlight streaming platforms.

* **Vendor ID (VID)**: `0x28de` (Valve Corporation)
* **Bluetooth LE Product ID (PID)**: `0x1303`
* **USB Wired / Wireless Dongle PIDs**: `0x1304` (wired interface) & `0x1305` (dongle wireless interface)
* **GATT Service UUID**: `100F6C32-1735-4313-B402-38567131E5F3`
* **BLE Input Characteristic UUIDs**:
  * `100F6C7A-1735-4313-B402-38567131E5F3` (Handles packet profile `0x45` reports)
  * `100F6C7C-1735-4313-B402-38567131E5F3` (Handles packet profile `0x47` reports)

### Connection Initialization (BLE vs 2015 D0G)
Unlike the original 2015 Steam Controller (D0G), which starts in "Lizard Mode" and requires a specialized vendor command sequence (`enterValveMode`: `0xC0 0x87 0x03 0x08 0x07 0x00`) to be written to the report characteristic before streaming reports, **Triton does not require any enter-mode commands**. Once paired and connected over BLE, it directly streams native input reports. Triton requests a large MTU size of **`517`** bytes to support Data Length Extension (DLE) for higher report rates and sensor precision.

---

## 2. Input Report Packet Layout

Under BLE, reports are delivered directly through notifications. The first byte acts as a rolling sequence counter, followed by the button masks and axis values.

### Packet Structure
```cpp
#pragma pack(push, 1)
struct TritonInputReport {
    uint8_t  sequence_counter; // Byte 0: Rolling sequence counter
    uint32_t buttons;          // Bytes 1-4: 32-bit button bitmask (only 20 bits active)
    uint16_t left_trigger;     // Bytes 5-6: Analog left trigger (0 to 65535)
    uint16_t right_trigger;    // Bytes 7-8: Analog right trigger (0 to 65535)
    int16_t  left_stick_x;     // Bytes 9-10: Left stick X axis
    int16_t  left_stick_y;     // Bytes 11-12: Left stick Y axis (negated)
    int16_t  right_stick_x;    // Bytes 13-14: Right stick X axis
    int16_t  right_stick_y;    // Bytes 15-16: Right stick Y axis (negated)
    
    // Bytes 17+ contain Gyro / Accelerometer sensor payload:
    // - For report type 'B'/'E': offsets 17-52 (36 bytes)
    // - For report type 'G': offsets 17-44 (28 bytes)
};
#pragma pack(pop)
```

---

## 3. Button Layout & Mappings

The Triton controller supports **20 digital buttons**. In the C++ native layer (`libmain.so`), raw button bits `0` to `19` are mapped to standard **SDL3 Gamepad Buttons** via a static lookup table. In the Java driver, these are translated into `ControllerPacket` flags.

| Raw Bit Index | Byte / Bit Mask | Physical Button | C++ SDL3 Mapping | Java `ControllerPacket` Mapping |
| :---: | :--- | :--- | :--- | :--- |
| **0** | `b0 & 0x01` | **A** | `SDL_GAMEPAD_BUTTON_SOUTH` | `ControllerPacket.A_FLAG` |
| **1** | `b0 & 0x02` | **B** | `SDL_GAMEPAD_BUTTON_EAST` | `ControllerPacket.B_FLAG` |
| **2** | `b0 & 0x04` | **X** | `SDL_GAMEPAD_BUTTON_WEST` | `ControllerPacket.X_FLAG` |
| **3** | `b0 & 0x08` | **Y** | `SDL_GAMEPAD_BUTTON_NORTH` | `ControllerPacket.Y_FLAG` |
| **4** | `b0 & 0x10` | **Share** | `SDL_GAMEPAD_BUTTON_MISC1` | `ControllerPacket.MISC_FLAG` |
| **5** | `b0 & 0x20` | **RS Click** | `SDL_GAMEPAD_BUTTON_RIGHT_STICK` | `ControllerPacket.RS_CLK_FLAG` |
| **6** | `b0 & 0x40` | **Start / Menu** | `SDL_GAMEPAD_BUTTON_START` | `ControllerPacket.PLAY_FLAG` |
| **7** | `b0 & 0x80` | **R4 / Right Paddle 1** | `SDL_GAMEPAD_BUTTON_RIGHT_PADDLE1` | `ControllerPacket.PADDLE1_FLAG` |
| **8** | `b1 & 0x01` | **R5 / Right Paddle 2** | `SDL_GAMEPAD_BUTTON_RIGHT_PADDLE2` | `ControllerPacket.PADDLE3_FLAG` |
| **9** | `b1 & 0x02` | **RB** | `SDL_GAMEPAD_BUTTON_RIGHT_SHOULDER`| `ControllerPacket.RB_FLAG` |
| **10** | `b1 & 0x04` | **DPAD Down** | `SDL_GAMEPAD_BUTTON_DPAD_DOWN` | `ControllerPacket.DOWN_FLAG` |
| **11** | `b1 & 0x08` | **DPAD Right** | `SDL_GAMEPAD_BUTTON_DPAD_RIGHT` | `ControllerPacket.RIGHT_FLAG` |
| **12** | `b1 & 0x10` | **DPAD Left** | `SDL_GAMEPAD_BUTTON_DPAD_LEFT` | `ControllerPacket.LEFT_FLAG` |
| **13** | `b1 & 0x20` | **DPAD Up** | `SDL_GAMEPAD_BUTTON_DPAD_UP` | `ControllerPacket.UP_FLAG` |
| **14** | `b1 & 0x40` | **Back / Options**| `SDL_GAMEPAD_BUTTON_BACK` | `ControllerPacket.BACK_FLAG` |
| **15** | `b1 & 0x80` | **LS Click** | `SDL_GAMEPAD_BUTTON_LEFT_STICK` | `ControllerPacket.LS_CLK_FLAG` |
| **16** | `b2 & 0x01` | **Guide (Steam)** | `SDL_GAMEPAD_BUTTON_GUIDE` | `ControllerPacket.SPECIAL_BUTTON_FLAG`|
| **17** | `b2 & 0x02` | **L4 / Left Paddle 1** | `SDL_GAMEPAD_BUTTON_LEFT_PADDLE1` | `ControllerPacket.PADDLE2_FLAG` |
| **18** | `b2 & 0x04` | **L5 / Left Paddle 2** | `SDL_GAMEPAD_BUTTON_LEFT_PADDLE2` | `ControllerPacket.PADDLE4_FLAG` |
| **19** | `b2 & 0x08` | **LB** | `SDL_GAMEPAD_BUTTON_LEFT_SHOULDER` | `ControllerPacket.LB_FLAG` |

### Capacitive Touch, Haptic Clicks, & Trigger Presses

Triton includes capacitive touch sensors, physical trackpad click switches, and physical trigger press switches mapped to the upper bits of the 32-bit button mask. When contact is made/broken or physical switches are actuated/released, these transitions act as digital button events.

| Raw Bit Index | Byte / Bit Mask | Sensor Name | Description | ON Hex Code | OFF Hex Code |
| :---: | :--- | :--- | :--- | :--- | :--- |
| **20** | `b2 & 0x10` | **Right Stick Touch** | Capacitive touch on Right Thumbstick | `0x00100000` | `0x00000000` |
| **21** | `b2 & 0x20` | **Right Trackpad Touch** | Capacitive touch (`trackpad_Z_on`) on Right Trackpad | `0x00200000` | `0x00000000` |
| **22** | `b2 & 0x40` | **Right Trackpad Click** | Physical click on Right Trackpad | `0x00400000` | `0x00000000` |
| **23** | `b2 & 0x80` | **Right Trigger Click** | Physical press on Right Trigger | `0x00800000` | `0x00000000` |
| **24** | `b3 & 0x01` | **Left Stick Touch** | Capacitive touch on Left Thumbstick | `0x01000000` | `0x00000000` |
| **25** | `b3 & 0x02` | **Left Trackpad Touch** | Capacitive touch (`trackpad_Z_on`) on Left Trackpad | `0x02000000` | `0x00000000` |
| **26** | `b3 & 0x04` | **Left Trackpad Click** | Physical click on Left Trackpad | `0x04000000` | `0x00000000` |
| **27** | `b3 & 0x08` | **Left Trigger Click** | Physical press on Left Trigger | `0x08000000` | `0x00000000` |
| **28** | `b3 & 0x10` | **Right Grip Touch** | Capacitive touch on Right Grip | `0x10000000` | `0x00000000` |
| **29** | `b3 & 0x20` | **Left Grip Touch** | Capacitive touch on Left Grip | `0x20000000` | `0x00000000` |

---

## 4. Gyroscope & Accelerometer (IMU)

Triton is equipped with a high-performance **6-axis IMU** (3-axis accelerometer and 3-axis gyroscope) to support motion-assisted aiming and gestures.

* **Sensor Data Formats**: Accelerometer and Gyroscope readings are packaged as signed 16-bit integers (`int16_t`).
* **Packet Routing & ID**:
  * Raw sensor payloads are populated inside `'B'` (0x42), `'E'` (0x45), or `'G'` (0x47) reports.
  * Over BLE, sensor data starts at byte index `17` of the packet.
  * For report types `'B'` and `'E'`, sensor fields occupy bytes 17–52.
  * For report type `'G'`, sensor fields occupy bytes 17–44.
* **Sensor Clearing**:
  If the host disables motion tracking or the controller is undergoing calibration, the native routing layer triggers `ClearSensorDataTritonController` to zero out the sensor bytes:
  * For `'B'`/`'E'` reports, offsets `0x1c` (8 bytes), `0x24` (8 bytes), `0x2c` (2 bytes), and `0x2e` (8 bytes - only for `'B'`) are cleared.
  * For `'G'` reports, offsets `0x1e` (8 bytes) and `0x26` (8 bytes) are cleared.

---

## 5. Rumble & Haptics Support

Triton features dual **Linear Resonant Actuators (LRAs)** instead of traditional ERM motors. These LRAs provide HD haptic feedback, reproducing subtle textures as well as intense vibrations.

* **Dynamic GATT Characteristic Mapping**: Over Bluetooth LE, Triton does not use a single, fixed write characteristic for output reports. Instead, output report characteristics are dynamically mapped based on the Report ID using the following formula:
  `Characteristic UUID = 100F6C[Report ID + 0x35]-1735-4313-B402-38567131E5F3`.
  For example, the standard Haptic Rumble Output Report (`Report ID 0x80` or `128`) uses characteristic `100F6CB5...` (`128 + 53 = 181 = 0xB5`). When sending reports to these mapped characteristics, the 1-byte Report ID prefix is omitted from the payload.
* **Rumble Emulation**: Standard low-frequency and high-frequency rumble commands sent by the host (GFE/Sunshine) are parsed by the client. The driver maps these to standard `MsgHapticRumble` payloads sent to the dynamically mapped output characteristic, which Triton's internal firmware translates into LRA vibration patterns. For full rumble strength, the haptic payloads typically require specific speed, duration, and gain configurations (`gain` is typically set to `2`).
* **Trigger Rumble**: Triton supports trigger-specific rumble (independent haptic feedback on the analog triggers).
* **Capacitive Touch Activation**: Triton features capacitive touch sensors on the trackpads, sticks, and grips ("Grip Sense"). Haptic "clicks" or textures are generated locally by the controller when touch events are detected, simulating mechanical buttons.

---

## 6. Identify Controller / Ping Feature

To assist users in identifying which physical controller is active (useful in multi-controller local co-op setups), Triton supports an **Identify/Ping** feature.

* **Triggering**: When the user requests to identify the controller in the UI, Moonlight writes a specific vendor haptic command packet to Triton's output characteristic.
* **Response**: Rather than a basic continuous vibration, Triton's LRAs are driven to play a short, distinctive audio/haptic chirp pattern (using frequency sweeps) to acoustically and tactilely alert the user.

---

## 7. Battery Status Reporting

Triton implements standard Bluetooth SIG specifications alongside custom telemetry for reliable battery monitoring.

1. **Standard GATT Battery Service**: Triton exposes the GATT Battery Service UUID `0x180F` with the Battery Level Characteristic `0x2A19`. This returns a direct, read-only integer value between `0` and `100` representing the current charge percentage.
2. **Voltage Telemetry**: Inside system status reports, Triton sends raw battery voltage data (measured in millivolts). This telemetry allows drivers to compute precise battery life curves and fire OS-level low-battery notifications when voltage thresholds are crossed.

---

## 8. Dual Trackpads

Triton inherits and refines the signature input layout of the Steam Deck, featuring **dual square trackpads** situated on the left and right sides of the controller.

* **Touch & Coordinate Tracking**:
  * The trackpads detect capacitive contact and report high-precision raw coordinates.
  * When touch-tracking is active, standard reports include X and Y coordinates formatted as signed 16-bit integers (`int16_t`) representing absolute touch positions along the axes.
  * Touch contact states (i.e. whether a finger is touching the surface) are mapped as digital touch flags.
* **Haptic Trackball & Scroll Emulation**:
  * The trackpads are physically backed by LRA haptic actuators.
  * Host drivers can enable internal emulation algorithms (such as virtual trackball friction, mouse scrolls, or radial virtual menus) where the LRA pulses simulate physical momentum, clicks, and detents beneath the user's thumb.

---

## 9. Status & Tracking LEDs

Triton features integrated **Light Emitting Diodes (LEDs)** embedded on the controller face. These LEDs serve two main purposes:

1. **Status & Player Indicator**:
   * The LEDs display device power state, Bluetooth pairing animations, and battery level alerts (e.g. low-battery slow pulsing).
   * In local multiplayer environments, the LEDs serve as player slot indicators (assigning unique visual indicator colors to Player 1, Player 2, etc.).
2. **Spatial / VR Headset Tracking**:
   * The LEDs are designed to be visually trackable by external VR hardware (such as Valve's "Steam Frame" headset) to provide precise 6-DOF controller tracking in mixed-reality and virtual-reality settings.
   * **Host Control**: The host controls the LED states (color, brightness, duty cycle, and pulse modulation) by writing vendor-specific HID Output Report packets directly to the controller's write characteristic.

---

## 10. Controller Settings & Modes

Triton inherits the extensive register configuration architecture of the original Steam Controller. Settings can be updated dynamically by sending an `ID_SET_SETTINGS_VALUES` (`0x87`) feature report.

### 10.1 Feature Report Message IDs
The host exchanges settings and command reports using the following message IDs:

| ID (Hex) | ID (Dec) | Constant Name | Description |
| :---: | :---: | :--- | :--- |
| `0x80` | 128 | `ID_SET_DIGITAL_MAPPINGS` | Set button mappings |
| `0x81` | 129 | `ID_CLEAR_DIGITAL_MAPPINGS` | Clear button mappings |
| `0x82` | 130 | `ID_GET_DIGITAL_MAPPINGS` | Get button mappings |
| `0x83` | 131 | `ID_GET_ATTRIBUTES_VALUES` | Query device attributes |
| `0x84` | 132 | `ID_GET_ATTRIBUTE_LABEL` | Query attribute text label |
| `0x85` | 133 | `ID_SET_DEFAULT_DIGITAL_MAPPINGS` | Restore default mappings |
| `0x86` | 134 | `ID_FACTORY_RESET` | Reset controller settings to factory defaults |
| `0x87` | 135 | `ID_SET_SETTINGS_VALUES` | Write one or more configuration registers |
| `0x88` | 136 | `ID_CLEAR_SETTINGS_VALUES` | Clear configuration registers |
| `0x89` | 137 | `ID_GET_SETTINGS_VALUES` | Query configuration registers |
| `0x8A` | 138 | `ID_GET_SETTING_LABEL` | Query settings text label |
| `0x8B` | 139 | `ID_GET_SETTINGS_MAXS` | Query setting maximum limits |
| `0x8C` | 140 | `ID_GET_SETTINGS_DEFAULTS` | Query setting default values |
| `0x8D` | 141 | `ID_SET_CONTROLLER_MODE` | Set active controller mode |
| `0x8E` | 142 | `ID_LOAD_DEFAULT_SETTINGS` | Load default configuration |
| `0x8F` | 143 | `ID_TRIGGER_HAPTIC_PULSE` | Fire a haptic feedback pulse |
| `0x9F` | 159 | `ID_TURN_OFF_CONTROLLER` | Turn off controller power |
| `0xA1` | 161 | `ID_GET_DEVICE_INFO` | Request basic device information |
| `0xA7` | 167 | `ID_CALIBRATE_TRACKPADS` | Perform trackpad calibration |
| `0xA9` | 169 | `ID_SET_SERIAL_NUMBER` | Set controller serial number |
| `0xAA` | 170 | `ID_GET_TRACKPAD_CALIBRATION` | Query trackpad calibration values |
| `0xAB` | 171 | `ID_GET_TRACKPAD_FACTORY_CALIBRATION` | Query factory trackpad calibration values |
| `0xAC` | 172 | `ID_GET_TRACKPAD_RAW_DATA` | Stream raw touchpad sensor data |
| `0xAD` | 173 | `ID_ENABLE_PAIRING` | Put controller in wireless pairing mode |
| `0xAE` | 174 | `ID_GET_STRING_ATTRIBUTE` | Retrieve string attributes |
| `0xAF` | 175 | `ID_RADIO_ERASE_RECORDS` | Clear saved radio pairing records |
| `0xB0` | 176 | `ID_RADIO_WRITE_RECORD` | Save a radio pairing record |
| `0xB1` | 177 | `ID_SET_DONGLE_SETTING` | Update dongle configuration |
| `0xB2` | 178 | `ID_DONGLE_DISCONNECT_DEVICE` | Request dongle connection teardown |
| `0xB3` | 179 | `ID_DONGLE_COMMIT_DEVICE` | Finalize dongle binding |
| `0xB4` | 180 | `ID_DONGLE_GET_WIRELESS_STATE` | Query wireless radio state |
| `0xB5` | 181 | `ID_CALIBRATE_GYRO` | Perform gyroscope calibration |
| `0xB6` | 182 | `ID_PLAY_AUDIO` | Play an audio track or tone on LRAs |
| `0xB7` | 183 | `ID_AUDIO_UPDATE_START` | Initiate audio firmware upload |
| `0xB8` | 184 | `ID_AUDIO_UPDATE_DATA` | Stream audio firmware data blocks |
| `0xB9` | 185 | `ID_AUDIO_UPDATE_COMPLETE` | Finalize audio firmware upload |
| `0xBA` | 186 | `ID_GET_CHIPID` | Request internal microcontroller chip ID |
| `0xBF` | 191 | `ID_CALIBRATE_JOYSTICK` | Calibrate analog stick |
| `0xC0` | 192 | `ID_CALIBRATE_ANALOG_TRIGGERS` | Calibrate trigger thresholds |
| `0xC1` | 193 | `ID_SET_AUDIO_MAPPING` | Configure audio-to-haptic mapping |
| `0xC2` | 194 | `ID_CHECK_GYRO_FW_LOAD` | Verify gyro firmware loading status |
| `0xC3` | 195 | `ID_CALIBRATE_ANALOG` | Perform general analog sensor calibration |
| `0xC4` | 196 | `ID_DONGLE_GET_CONNECTED_SLOTS` | Query connected receiver channels |
| `0xCE` | 206 | `ID_RESET_IMU` | Reset motion sensors |
| `0xEA` | 234 | `ID_TRIGGER_HAPTIC_CMD` | (Deck) Trigger haptic feedback |
| `0xEB` | 235 | `ID_TRIGGER_RUMBLE_CMD` | (Deck) Trigger rumble feedback |

### 10.2 Configuration Settings Registers
The following settings registers can be read or written to adjust the controller's internal behavior:

| Register (Dec) | Register (Hex) | Constant Name | Description |
| :---: | :---: | :--- | :--- |
| **0** | `0x00` | `SETTING_MOUSE_SENSITIVITY` | Mouse pointer speed modifier |
| **1** | `0x01` | `SETTING_MOUSE_ACCELERATION` | Mouse acceleration curve |
| **2** | `0x02` | `SETTING_TRACKBALL_ROTATION_ANGLE` | Trackball virtual angle alignment |
| **3** | `0x03` | `SETTING_HAPTIC_INTENSITY_UNUSED` | Reserved/Unused |
| **4** | `0x04` | `SETTING_LEFT_GAMEPAD_STICK_ENABLED` | Enable left analog stick reporting |
| **5** | `0x05` | `SETTING_RIGHT_GAMEPAD_STICK_ENABLED` | Enable right analog stick reporting |
| **6** | `0x06` | `SETTING_USB_DEBUG_MODE` | Configure USB logging and diagnostic flags |
| **7** | `0x07` | `SETTING_LEFT_TRACKPAD_MODE` | Mapping mode for left trackpad (e.g. mouse, dpad, joystick) |
| **8** | `0x08` | `SETTING_RIGHT_TRACKPAD_MODE` | Mapping mode for right trackpad |
| **9** | `0x09` | `SETTING_MOUSE_POINTER_ENABLED` | Toggle local mouse pointer emulation (Lizard Mode toggle) |
| **10** | `0x0A` | `SETTING_DPAD_DEADZONE` | Deadzone threshold for virtual DPAD configurations |
| **11** | `0x0B` | `SETTING_MINIMUM_MOMENTUM_VEL` | Minimum virtual trackball velocity before stopping |
| **12** | `0x0C` | `SETTING_MOMENTUM_DECAY_AMMOUNT` | Virtual trackball friction decay rate |
| **13** | `0x0D` | `SETTING_TRACKPAD_RELATIVE_MODE_TICKS_PER_PIXEL` | Tracking resolution modifier |
| **14** | `0x0E` | `SETTING_HAPTIC_INCREMENT` | Tick rate interval for trackpad movement feedback |
| **15** | `0x0F` | `SETTING_DPAD_ANGLE_SIN` | Sine of dpad rotation angle |
| **16** | `0x10` | `SETTING_DPAD_ANGLE_COS` | Cosine of dpad rotation angle |
| **17** | `0x11` | `SETTING_MOMENTUM_VERTICAL_DIVISOR` | Damping factor for virtual vertical momentum |
| **18** | `0x12` | `SETTING_MOMENTUM_MAXIMUM_VELOCITY` | Speed limit for virtual trackball rotation |
| **19** | `0x13` | `SETTING_TRACKPAD_Z_ON` | Touch threshold for right trackpad contact activation |
| **20** | `0x14` | `SETTING_TRACKPAD_Z_OFF` | Release threshold for right trackpad contact deactivation |
| **21** | `0x15` | `SETTING_SENSITIVY_SCALE_AMMOUNT` | Sensitivity scale factor |
| **22** | `0x16` | `SETTING_LEFT_TRACKPAD_SECONDARY_MODE` | Secondary mapping for left trackpad shift operations |
| **23** | `0x17` | `SETTING_RIGHT_TRACKPAD_SECONDARY_MODE` | Secondary mapping for right trackpad shift operations |
| **24** | `0x18` | `SETTING_SMOOTH_ABSOLUTE_MOUSE` | Enable mouse smoothing filter |
| **25** | `0x19` | `SETTING_STEAMBUTTON_POWEROFF_TIME` | Hold duration for Guide button to turn off controller |
| **26** | `0x1A` | `SETTING_UNUSED_1` | Reserved |
| **27** | `0x1B` | `SETTING_TRACKPAD_OUTER_RADIUS` | Boundary threshold for outer-ring trigger mappings |
| **28** | `0x1C` | `SETTING_TRACKPAD_Z_ON_LEFT` | Touch threshold for left trackpad contact activation |
| **29** | `0x1D` | `SETTING_TRACKPAD_Z_OFF_LEFT` | Release threshold for left trackpad contact deactivation |
| **30** | `0x1E` | `SETTING_TRACKPAD_OUTER_SPIN_VEL` | Outer-ring auto-scroll spin speed |
| **31** | `0x1F` | `SETTING_TRACKPAD_OUTER_SPIN_RADIUS` | Inner edge threshold for outer-ring spin activation |
| **32** | `0x20` | `SETTING_TRACKPAD_OUTER_SPIN_HORIZONTAL_ONLY` | Limit outer spin axis to horizontal |
| **33** | `0x21` | `SETTING_TRACKPAD_RELATIVE_MODE_DEADZONE` | Deadzone for relative tracking configurations |
| **34** | `0x22` | `SETTING_TRACKPAD_RELATIVE_MODE_MAX_VEL` | Velocity cap for relative tracking |
| **35** | `0x23` | `SETTING_TRACKPAD_RELATIVE_MODE_INVERT_Y` | Invert vertical axis for trackpad relative tracking |
| **36** | `0x24` | `SETTING_TRACKPAD_DOUBLE_TAP_BEEP_ENABLED` | Toggle audio beep feedback on trackpad double-tap |
| **37** | `0x25` | `SETTING_TRACKPAD_DOUBLE_TAP_BEEP_PERIOD` | Frequency tone pitch for double-tap beep |
| **38** | `0x26` | `SETTING_TRACKPAD_DOUBLE_TAP_BEEP_COUNT` | Repeat count of beep feedback pulses |
| **39** | `0x27` | `SETTING_TRACKPAD_OUTER_RADIUS_RELEASE_ON_TRANSITION` | Configure outer ring button behavior |
| **40** | `0x28` | `SETTING_RADIAL_MODE_ANGLE` | Sector width angle for radial virtual menus |
| **41** | `0x29` | `SETTING_HAPTIC_INTENSITY_MOUSE_MODE` | Actuator vibration intensity when trackpads emulate a mouse |
| **42** | `0x2A` | `SETTING_LEFT_DPAD_REQUIRES_CLICK` | Left trackpad dpad requires click before firing events |
| **43** | `0x2B` | `SETTING_RIGHT_DPAD_REQUIRES_CLICK` | Right trackpad dpad requires click before firing events |
| **44** | `0x2C` | `SETTING_LED_BASELINE_BRIGHTNESS` | Baseline brightness of status indicators |
| **45** | `0x2D` | `SETTING_LED_USER_BRIGHTNESS` | User preferred brightness of status indicators |
| **46** | `0x2E` | `SETTING_ENABLE_RAW_JOYSTICK` | Enable direct reporting of uncalibrated analog joystick values |
| **47** | `0x2F` | `SETTING_ENABLE_FAST_SCAN` | Accelerate BLE polling cycle intervals (6ms vs 9ms) |
| **48** | `0x30` | `SETTING_IMU_MODE` | Configure motion tracking mode (gyroscope/accelerometer reporting) |
| **49** | `0x31` | `SETTING_WIRELESS_PACKET_VERSION` | Set protocol payload format version for radio |
| **50** | `0x32` | `SETTING_SLEEP_INACTIVITY_TIMEOUT` | Idle duration threshold before automatic power-down |
| **51** | `0x33` | `SETTING_TRACKPAD_NOISE_THRESHOLD` | Jitter filtering sensitivity threshold |
| **52** | `0x34` | `SETTING_LEFT_TRACKPAD_CLICK_PRESSURE` | Force sensor threshold for physical click mapping on Left Trackpad |
| **53** | `0x35` | `SETTING_RIGHT_TRACKPAD_CLICK_PRESSURE` | Force sensor threshold for physical click mapping on Right Trackpad |
| **54** | `0x36` | `SETTING_LEFT_BUMPER_CLICK_PRESSURE` | Force threshold for Left Bumper |
| **55** | `0x37` | `SETTING_RIGHT_BUMPER_CLICK_PRESSURE` | Force threshold for Right Bumper |
| **56** | `0x38` | `SETTING_LEFT_GRIP_CLICK_PRESSURE` | Force threshold for Left Grip paddle |
| **57** | `0x39` | `SETTING_RIGHT_GRIP_CLICK_PRESSURE` | Force threshold for Right Grip paddle |
| **58** | `0x3A` | `SETTING_LEFT_GRIP2_CLICK_PRESSURE` | Force threshold for secondary Left Grip paddle |
| **59** | `0x3B` | `SETTING_RIGHT_GRIP2_CLICK_PRESSURE` | Force threshold for secondary Right Grip paddle |
| **60** | `0x3C` | `SETTING_PRESSURE_MODE` | Pressure detection and mapping configuration |
| **61** | `0x3D` | `SETTING_CONTROLLER_TEST_MODE` | Toggle internal firmware diagnostic test states |
| **62** | `0x3E` | `SETTING_TRIGGER_MODE` | Configure analog trigger curves and actuation thresholds |
| **63** | `0x3F` | `SETTING_TRACKPAD_Z_THRESHOLD` | Threshold value for touch surface touch force mapping |
| **64** | `0x40` | `SETTING_FRAME_RATE` | Set internal firmware polling loop rate |
| **65** | `0x41` | `SETTING_TRACKPAD_FILT_CTRL` | Filtering filter coefficient for trackpad position tracking |
| **66** | `0x42` | `SETTING_TRACKPAD_CLIP` | Set coordinate boundaries |
| **67** | `0x43` | `SETTING_DEBUG_OUTPUT_SELECT` | Direct telemetry channels to debug port |
| **68** | `0x44` | `SETTING_TRIGGER_THRESHOLD_PERCENT` | Percentage travel required for digital trigger click events |
| **69** | `0x45` | `SETTING_TRACKPAD_FREQUENCY_HOPPING` | Toggle anti-jamming frequency hopping on trackpad sensors |
| **70** | `0x46` | `SETTING_HAPTICS_ENABLED` | Global enable toggle for LRA haptic feedback |
| **71** | `0x47` | `SETTING_STEAM_WATCHDOG_ENABLE` | Toggle safety keep-alive watchdog timer |
| **72** | `0x48` | `SETTING_TIMP_TOUCH_THRESHOLD_ON` | Touch-activation threshold |
| **73** | `0x49` | `SETTING_TIMP_TOUCH_THRESHOLD_OFF` | Touch-release threshold |
| **74** | `0x4A` | `SETTING_FREQ_HOPPING` | Radio channel anti-jamming configuration |
| **75** | `0x4B` | `SETTING_TEST_CONTROL` | Diagnostic system controls |
| **76** | `0x4C` | `SETTING_HAPTIC_MASTER_GAIN_DB` | Master haptic volume/intensity damping offset (dB) |
| **77** | `0x4D` | `SETTING_THUMB_TOUCH_THRESH` | Capacitive touch sensor threshold on thumbsticks |
| **78** | `0x4E` | `SETTING_DEVICE_POWER_STATUS` | Query or control internal power system modes |
| **79** | `0x4F` | `SETTING_HAPTIC_INTENSITY` | Global baseline vibration amplitude scaling factor |
| **80** | `0x50` | `SETTING_STABILIZER_ENABLED` | Enable stabilizer filter |
| **81** | `0x51` | `SETTING_TIMP_MODE_MTE` | Virtual tactile texture configuration |

### 10.3 Haptic Output Report Types
Haptic-specific outputs are directed to their corresponding report IDs:

| Report ID (Hex) | Report ID (Dec) | Constant Name | Description |
| :---: | :---: | :--- | :--- |
| `0x80` | 128 | `ID_OUT_REPORT_HAPTIC_RUMBLE` | Continuous rumble emulation |
| `0x81` | 129 | `ID_OUT_REPORT_HAPTIC_PULSE` | Single haptic pulse event |
| `0x82` | 130 | `ID_OUT_REPORT_HAPTIC_COMMAND` | Low-level configuration command |
| `0x83` | 131 | `ID_OUT_REPORT_HAPTIC_LFO_TONE` | Low-frequency oscillator tone |
| `0x84` | 132 | `ID_OUT_REPORT_HAPTIC_LOG_SWEEP` | Logarithmic frequency sweep tone |
| `0x85` | 133 | `ID_OUT_REPORT_HAPTIC_SCRIPT` | Pre-programmed haptic sequence script |
