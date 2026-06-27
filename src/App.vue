<script setup lang="ts">
import { ref, onMounted, onUnmounted, reactive } from 'vue';
import { SteamController } from './steamController';
import StatusBar from './components/StatusBar.vue';


const controller = reactive(new SteamController());
const videoRef = ref<HTMLVideoElement | null>(null);
const canvasRef = ref<HTMLCanvasElement | null>(null);
const isConnected = ref(false);
const isTracking = ref(false);
const statusMsg = ref("Ready to connect.");

let animationFrameId = 0;

const connectHID = async () => {
  statusMsg.value = "Connecting HID device...";
  const success = await controller.connect();
  if (success) {
    isConnected.value = true;
    statusMsg.value = "Steam Controller Connected!";
  } else {
    statusMsg.value = "Please connect to Steam Controller manually.";
  }
};

const startCamera = async () => {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoDevices = devices.filter(d => d.kind === 'videoinput');
    let targetDevice = videoDevices.find(d => d.label.includes('Mx Brio') || d.label.includes('Brio'));
    
    const constraints: MediaStreamConstraints = {
      video: targetDevice ? { deviceId: { exact: targetDevice.deviceId } } : true
    };
    
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    if (videoRef.value) {
      videoRef.value.srcObject = stream;
      videoRef.value.play();
    }
    
    statusMsg.value = "Camera started. Waiting for OpenCV...";
    
    const checkCV = setInterval(() => {
      if ((window as any).cv && (window as any).cv.calcOpticalFlowPyrLK) {
        clearInterval(checkCV);
        statusMsg.value = "Waiting for video stream...";
        
        // Wait for video dimensions and auto-detect
        videoRef.value?.addEventListener('loadeddata', () => {
          setTimeout(autoDetect, 1000); // Give the camera 1s to adjust exposure
        });
      }
    }, 500);

  } catch (err) {
    console.error(err);
    statusMsg.value = "Camera error: " + String(err);
  }
};

// Tracking State
let selectionStep = 0; // 0: Puck, 1: Controller Front, 2: Controller Back, 3: Tracking
let trackPoints: {x: number, y: number}[] = [];
let oldGray: any = null;
let p0: any = null;

const autoDetect = async () => {
  if (!canvasRef.value || !videoRef.value) return;
  const canvas = canvasRef.value;
  const video = videoRef.value;
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return;

  try {
    const saved = localStorage.getItem('trackPoints');
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed && parsed.length === 3) {
        trackPoints = parsed;
        selectionStep = 3;
        statusMsg.value = "Targets restored from previous session! Tracking started!";
        isTracking.value = true;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        initOpticalFlow();
        processVideo();
        return;
      }
    }
  } catch (e) {}

  statusMsg.value = "Click the Charging Puck to begin.";
  // Start the video drawing loop so the user can see what to click!
  processVideo();
};

const onCanvasClick = (e: MouseEvent) => {
  if (selectionStep >= 3 || !canvasRef.value) return;
  const rect = canvasRef.value.getBoundingClientRect();
  const x = (e.clientX - rect.left) * (canvasRef.value.width / rect.width);
  const y = (e.clientY - rect.top) * (canvasRef.value.height / rect.height);
  
  trackPoints.push({x, y});
  selectionStep++;
  
  if (selectionStep === 1) {
    statusMsg.value = "Now click the Steam button on the controller.";
  } else if (selectionStep === 2) {
    statusMsg.value = "Now click the Share button on the controller.";
  } else if (selectionStep === 3) {
    statusMsg.value = "Tracking started!";
    localStorage.setItem('trackPoints', JSON.stringify(trackPoints));
    isTracking.value = true;
    
    // Draw current frame before init
    const video = videoRef.value!;
    const ctx = canvasRef.value.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(video, 0, 0, canvasRef.value.width, canvasRef.value.height);
    
    initOpticalFlow();
  }
};


const initOpticalFlow = () => {
  const cv = (window as any).cv;
  if (!canvasRef.value) return;
  
  const ctx = canvasRef.value.getContext('2d');
  if (!ctx) return;
  
  const imageData = ctx.getImageData(0, 0, canvasRef.value.width, canvasRef.value.height);
  const frame = cv.matFromImageData(imageData);
  
  oldGray = new cv.Mat();
  cv.cvtColor(frame, oldGray, cv.COLOR_RGBA2GRAY);
  
  p0 = new cv.Mat(3, 1, cv.CV_32FC2);
  p0.data32F[0] = trackPoints[0].x; p0.data32F[1] = trackPoints[0].y;
  p0.data32F[2] = trackPoints[1].x; p0.data32F[3] = trackPoints[1].y;
  p0.data32F[4] = trackPoints[2].x; p0.data32F[5] = trackPoints[2].y;
  
  frame.delete();
};

// PID State
let lastState = "STOP";

const sendControl = async (state: string) => {
  if (state === lastState) return;
  lastState = state;
  
  if (state === "STOP") {
    await controller.stopAll();
  } else if (state === "FORWARD") {
    await controller.pulse(0, 70);
    await controller.pulse(1, 70);
  } else if (state === "LEFT") {
    await controller.pulse(0, 70);
    await controller.stop(1);
  } else if (state === "RIGHT") {
    await controller.stop(0);
    await controller.pulse(1, 70);
  }
};

const processVideo = () => {
  if (!videoRef.value || !canvasRef.value) return;
  const video = videoRef.value;
  const canvas = canvasRef.value;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const cv = (window as any).cv;
  
  if (!ctx || video.videoWidth === 0 || !cv) {
    animationFrameId = requestAnimationFrame(processVideo);
    return;
  }
  
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  
  // Draw selections if not fully tracking
  if (selectionStep < 3) {
    ctx.fillStyle = 'red';
    trackPoints.forEach(p => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 5, 0, 2*Math.PI);
      ctx.fill();
    });
    animationFrameId = requestAnimationFrame(processVideo);
    return;
  }
  
  // Optical Flow tracking
  if (selectionStep === 3 && oldGray && p0) {
    const frame = cv.imread(canvas);
    const frameGray = new cv.Mat();
    cv.cvtColor(frame, frameGray, cv.COLOR_RGBA2GRAY);
    
    const p1 = new cv.Mat();
    const st = new cv.Mat();
    const err = new cv.Mat();
    const winSize = new cv.Size(31, 31);
    const maxLevel = 3;
    const criteria = new cv.TermCriteria(cv.TERM_CRITERIA_EPS | cv.TERM_CRITERIA_COUNT, 30, 0.01);
    
    cv.calcOpticalFlowPyrLK(oldGray, frameGray, p0, p1, st, err, winSize, maxLevel, criteria);
    
    // Check if points are still tracked
    let allTracked = true;
    for (let i = 0; i < 3; i++) {
      if (st.data[i] === 0) {
        allTracked = false;
        break;
      }
    }
    
    if (allTracked) {
      const px = p1.data32F[0], py = p1.data32F[1];
      const fx = p1.data32F[2], fy = p1.data32F[3];
      const bx = p1.data32F[4], by = p1.data32F[5];
      
      // Draw points
      ctx.fillStyle = 'lime';
      [ {x: px, y: py}, {x: fx, y: fy}, {x: bx, y: by} ].forEach(p => {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 5, 0, 2*Math.PI);
        ctx.fill();
      });
      
      // Draw controller orientation line
      ctx.strokeStyle = 'yellow';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(fx, fy);
      ctx.stroke();
      
      // Draw target line
      const cx = (fx + bx) / 2;
      const cy = (fy + by) / 2;
      ctx.strokeStyle = 'rgba(0, 255, 0, 0.5)';
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(px, py);
      ctx.stroke();
      
      // Update p0 and oldGray for next frame
      p0.data32F.set(p1.data32F);
      oldGray.delete();
      oldGray = frameGray.clone();
      
      // Navigation
      if (isConnected.value) {
        const dx = px - cx;
        const dy = py - cy;
        const dist = Math.sqrt(dx*dx + dy*dy);
        const targetHeading = Math.atan2(dy, dx);
        
        const cHeading = Math.atan2(fy - by, fx - bx);
        
        let angleErr = targetHeading - cHeading;
        while (angleErr > Math.PI) angleErr -= 2 * Math.PI;
        while (angleErr < -Math.PI) angleErr += 2 * Math.PI;
        
        if (controller.batteryPercent >= 100) {
          sendControl("STOP");
          statusMsg.value = "Battery full! Auto-Charge not needed.";
          isTracking.value = false;
        } else if (controller.isCharging) {
          sendControl("STOP");
          statusMsg.value = "Charging! Auto-Charge complete!";
          isTracking.value = false;
        } else if (dist < 12) {
          sendControl("STOP");
          statusMsg.value = "Arrived at puck!";
        } else if (Math.abs(angleErr) > 0.3) {
          if (angleErr > 0) {
            sendControl("RIGHT");
            statusMsg.value = "Turning Right";
          } else {
            sendControl("LEFT");
            statusMsg.value = "Turning Left";
          }
        } else {
          // Slow down if getting close
          if (dist < 150 && Date.now() % 500 > 250) {
            sendControl("STOP");
            statusMsg.value = "Creeping Forward...";
          } else {
            sendControl("FORWARD");
            statusMsg.value = "Moving Forward";
          }
        }
      }
    } else {
      sendControl("STOP");
      statusMsg.value = "Tracking lost! Refresh the page to select points again.";
    }
    
    frame.delete();
    frameGray.delete();
    p1.delete();
    st.delete();
    err.delete();
  }
  
  animationFrameId = requestAnimationFrame(processVideo);
};

onMounted(async () => {
  startCamera();
  const success = await controller.autoConnect();
  if (success) {
    isConnected.value = true;
    statusMsg.value = "Steam Controller Auto-Connected!";
  }
});

onUnmounted(() => {
  if (animationFrameId) cancelAnimationFrame(animationFrameId);
  controller.stopAll();
  if (oldGray) oldGray.delete();
  if (p0) p0.delete();
});

const resetTracking = async () => {
  await controller.stopAll();
  localStorage.removeItem('trackPoints');
  window.location.reload();
};

</script>

<template>
  <div class="app-container">
    <header class="masthead">
      <h1>Steam Controller Auto-Charge</h1>
      <p class="status">{{ statusMsg }}</p>
      
      <StatusBar v-if="isConnected" :controller="controller" />

      <div class="controls">
        <button @click="connectHID" :disabled="isConnected" class="btn-cta">
          {{ isConnected ? 'Controller Linked' : 'Connect Steam Controller' }}
        </button>
        <button v-if="selectionStep === 3" @click="resetTracking" class="btn-reset">
          STOP / Reset
        </button>
      </div>
    </header>
    
    <main>
      <video ref="videoRef" playsinline muted hidden></video>
      <canvas ref="canvasRef" @click="onCanvasClick" class="video-canvas" :style="{ cursor: selectionStep < 3 ? 'crosshair' : 'default' }"></canvas>
    </main>
    <div class="instructions">
      <h3>Instructions:</h3>
      <ol>
        <li>Connect the Steam Controller.</li>
        <li>Ensure camera is directly overhead.</li>
        <li>Click the Puck, then the Steam button, then the Share button.</li>
        <li>These points will be saved automatically for your next refresh!</li>
      </ol>
      <p>The app will track those pixels and steer the controller home using computer vision!</p>
    </div>

    <div class="disclaimer">
      <p><strong>Disclaimer:</strong> This project is not affiliated with, endorsed by, or in any way associated with Steam or Valve Corporation. They won't even give me an allocation for a Steam Machine.</p>
    </div>
  </div>
</template>

<style scoped>
.app-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  min-height: 100vh;
  background: #111;
  color: #fff;
  font-family: system-ui, sans-serif;
}
.masthead {
  text-align: center;
  padding: 2rem;
}
.disclaimer {
  margin-top: 20px;
  padding: 15px 20px;
  background-color: rgba(255, 0, 0, 0.1);
  border: 1px solid rgba(255, 0, 0, 0.3);
  border-radius: 8px;
  max-width: 600px;
  text-align: center;
  font-size: 0.9rem;
  color: #ccc;
}
.disclaimer p {
  margin: 0;
}
.btn-cta, .btn-reset {
  background: #3498db;
  color: white;
  border: none;
  padding: 10px 20px;
  border-radius: 5px;
  font-size: 1.2rem;
  cursor: pointer;
  transition: background 0.2s;
  margin: 0 10px;
}
.btn-reset {
  background: #e74c3c;
}
.btn-cta:hover:not(:disabled) {
  background: #2980b9;
}
.btn-reset:hover {
  background: #c0392b;
}
.btn-cta:disabled {
  background: #555;
  cursor: not-allowed;
}
.status {
  font-weight: bold;
  color: #f39c12;
  margin-bottom: 10px;
  font-size: 1.2rem;
}

.controls {
  display: flex;
  justify-content: center;
  margin-top: 10px;
}
.video-canvas {
  width: 800px;
  max-width: 100%;
  border: 2px solid #333;
  border-radius: 8px;
  background: #000;
  box-shadow: 0 0 20px rgba(0,0,0,0.5);
}
.instructions {
  margin-top: 2rem;
  background: #222;
  padding: 1rem 2rem;
  border-radius: 8px;
  text-align: left;
}
</style>
