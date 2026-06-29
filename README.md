# Steam Controller Auto-Charge

Steam Controller Auto-Charge is an open-source web application designed to automatically pilot a Steam Controller into its magnetic charging puck using optical flow computer vision and WebHID telemetry.

## Features

- **Optical Flow Tracking:** Utilizes OpenCV.js to track user-selected points on the controller and the charging puck via an overhead camera.
- **WebHID Telemetry & Haptic Navigation:** Connects to the Triton Controller natively via WebHID, streaming input and telemetry (Report 67). Navigates the controller towards the puck by firing 70Hz asymmetric haptic pulses through the internal dual Linear Resonant Actuators (LRAs).
- **Proximity Creep Mode:** Automatically cuts haptic pulse frequency by 50% when the controller is within 150 pixels of the puck to ensure a gentle magnetic dock.
- **Battery Status Polling:** Intercepts Report ID `121` (`0x79`) to confirm successful magnetic charging, and parses Report ID `67` (`0x43`) to display live battery percentage and battery cell voltage (mV).

## Setup

### Requirements
- **[Nix Package Manager](https://nixos.org/download)**: The *only* build dependency you need. It works seamlessly on Windows, Mac, and Linux.
  - A Chromium-based browser supporting the WebHID API.
  - An overhead webcam pointing down at your desk.

1. Mount a webcam directly overhead pointing at the desk.
2. Start the project with a single command (this will automatically fetch dependencies and build the WASM module):

```bash
nix-shell --run "npm install && npm run dev"
```

## Usage

1. Mount a webcam directly overhead pointing at the desk.
2. Place the Steam Controller Auto-Charge puck on the desk.
3. Place your Steam Controller on the desk, upright.
4. Open the web interface and click **Connect Steam Controller** to pair it via WebHID.
5. Click **✨ Auto-Track** to engage automatic tracking. The button will highlight to indicate it's active and will automatically resume tracking on page reload. Click it again to disengage.
6. The controller will now autonomously navigate to the puck using a Lucas-Kanade optical flow loop combined with obstacle avoidance powered by an in-browser Rust/WASM CNN!

*(Note: Manual tracking is still available if you prefer. Just click the puck, then the top of the controller, then the bottom of the controller).*

## Architecture

- `App.vue`: Vue 3 application logic handling camera streams, UI reactivity, PID tracking loop, and OpenCV.js Lucas-Kanade optical flow (`calcOpticalFlowPyrLK`).
- `steamController.ts`: WebHID abstraction class mapping standard API calls to the Steam Controller's specific byte payloads for LRA pulses and battery status polling.
- `obstacleDetector.ts` & `obstacleWorker.ts`: Offloads obstacle detection to a Web Worker to ensure the main tracking loop remains fluid.
- `wasm-obstacle-detect/`: Rust implementation compiled to WebAssembly for high-performance visual processing.

## Thanks

Huge thanks to Very Lazy Pixel for inspiring this project! 
Check out their video here: [https://www.youtube.com/watch?v=g-8S8zk4dn8](https://www.youtube.com/watch?v=g-8S8zk4dn8)

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
