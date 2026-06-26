# Triton Auto-Charge Vision Tracker

Triton Auto-Charge Vision Tracker is an open-source web application designed to automatically pilot a Triton (2026 Steam Controller) into its magnetic charging puck using optical flow computer vision and WebHID telemetry.

## Features

- **Optical Flow Tracking:** Utilizes OpenCV.js to track user-selected points on the controller and the charging puck via an overhead camera.
- **WebHID Telemetry & Haptic Navigation:** Connects to the Triton Controller natively via WebHID, streaming input and telemetry (Report 67). Navigates the controller towards the puck by firing 70Hz asymmetric haptic pulses through the internal dual Linear Resonant Actuators (LRAs).
- **Proximity Creep Mode:** Automatically cuts haptic pulse frequency by 50% when the controller is within 150 pixels of the puck to ensure a gentle magnetic dock.
- **Battery Status Polling:** Intercepts Report ID `121` (`0x79`) to confirm successful magnetic charging, and parses Report ID `67` (`0x43`) to display live battery percentage and battery cell voltage (mV).
- **Auto-Memory:** Leverages `localStorage` to remember the precise pixel points on your desk for immediate tracking on subsequent launches.

## Setup

1. Position an overhead webcam looking down at your desk.
2. Ensure you are using a Chromium-based browser supporting the WebHID API.
3. Install dependencies and run the development server:

```bash
npm install
npm run dev
```

4. Click **"Connect Steam Controller"** and authorize the device prompt.
5. Click the physical Charging Puck, the front of the controller, and the back of the controller on the video feed to begin autonomous tracking.

## Architecture

- `App.vue`: Vue 3 application logic handling camera streams, UI reactivity, PID tracking loop, and OpenCV.js Lucas-Kanade optical flow (`calcOpticalFlowPyrLK`).
- `steamController.ts`: WebHID abstraction class mapping standard API calls to the Triton Controller's specific byte payloads for LRA pulses and battery status polling.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
