<script setup lang="ts">
import { ref, onMounted, onUnmounted, reactive } from 'vue';
import cvModule from '@techstark/opencv-js';
import { SteamController } from './steamController';
import StatusBar from './components/StatusBar.vue';
import { ObstacleDetector } from './obstacleDetector';

const detector = new ObstacleDetector();


const controller = reactive(new SteamController());
const videoRef = ref<HTMLVideoElement | null>(null);
const canvasRef = ref<HTMLCanvasElement | null>(null);
const isConnected = ref(false);
const isTracking = ref(false);
const autoTrackEngaged = ref(false);
const statusMsg = ref("Ready to connect.");
const showNNOverlay = ref(true);

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
    
    let cv = cvModule as any;
    if (cv instanceof Promise) {
      cv = await cv;
    } else if (!cv.Mat) {
      await new Promise<void>((resolve) => {
        cv.onRuntimeInitialized = () => resolve();
      });
    }

    if (cv.calcOpticalFlowPyrLK) {
      statusMsg.value = "Click the Charging Puck to begin.";
      
      // Wait for video dimensions and auto-detect
      if (videoRef.value && videoRef.value.readyState >= 2) {
        setTimeout(autoDetect, 1000);
      } else {
        videoRef.value?.addEventListener('loadeddata', () => {
          setTimeout(autoDetect, 1000); // Give the camera 1s to adjust exposure
        });
      }
      
      try {
        await detector.init();
      } catch (err) {
        console.error("Failed to initialize obstacle detector", err);
      }
    } else {
      statusMsg.value = "Failed to load OpenCV!";
    }

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

  if (localStorage.getItem('autoTrackEngaged') === 'true') {
    autoTrackEngaged.value = true;
    processVideo(); // Kick off the live loop so the CNN can process frames
    
    // Poll until the CNN worker returns at least one frame's result
    const checkCNN = () => {
      if (detector.result !== null) {
        autoTrack();
      } else {
        setTimeout(checkCNN, 100);
      }
    };
    checkCNN();
    return;
  }

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


const initOpticalFlow = async () => {
  if (!canvasRef.value) return;
  let cv = cvModule as any;
  if (cv instanceof Promise) cv = await cv;
  
  const ctx = canvasRef.value.getContext('2d');
  if (!ctx) return;
  
  const imageData = ctx.getImageData(0, 0, canvasRef.value.width, canvasRef.value.height);
  const frame = cv.matFromImageData(imageData);
  
  oldGray = new cv.Mat();
  cv.cvtColor(frame, oldGray, cv.COLOR_RGBA2GRAY);
  
  p0 = new cv.Mat(2, 1, cv.CV_32FC2);
  p0.data32F[0] = trackPoints[1].x; p0.data32F[1] = trackPoints[1].y;
  p0.data32F[2] = trackPoints[2].x; p0.data32F[3] = trackPoints[2].y;
  
  frame.delete();
};

// PID State
let lastState = "STOP";
let arrivalTime: number | null = null;
let shimmyStartTime: number | null = null;
let isFailed = false;
const SHIMMY_DURATIONS = [2000, 2000, 3000, 3000, 4000, 4000, 5000, 5000];

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

const processVideo = async () => {
  if (controller.eStop) return;
  
  if (!videoRef.value || !canvasRef.value) return;
  const video = videoRef.value;
  const canvas = canvasRef.value;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  
  let cv = cvModule as any;
  if (cv instanceof Promise) cv = await cv;
  
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
    trackPoints.forEach((p, i) => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 5, 0, 2*Math.PI);
      ctx.fill();
      
      ctx.fillStyle = "white";
      ctx.font = "14px Arial";
      ctx.fillText((i+1).toString(), p.x + 8, p.y + 4);
      ctx.fillStyle = 'red';
    });
    
    // Draw obstacles even during selection phase
    if (detector.ready) {
      detector.detectFromCanvas(canvas);
      if (showNNOverlay.value) {
        detector.drawDetections(ctx);
      }
    }
    
    animationFrameId = requestAnimationFrame(processVideo);
    return;
  }
  
  if (detector.ready) {
    detector.detectFromCanvas(canvas);
    if (showNNOverlay.value) {
      detector.drawDetections(ctx);
    }
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
    const criteria = new cv.TermCriteria(cv.TermCriteria_EPS | cv.TermCriteria_COUNT, 30, 0.01);
    
    cv.calcOpticalFlowPyrLK(oldGray, frameGray, p0, p1, st, err, winSize, maxLevel, criteria);
    
    // Check if points are still tracked
    let allTracked = true;
    for (let i = 0; i < 2; i++) {
      if (st.data[i] === 0) {
        allTracked = false;
        break;
      }
    }
    
    if (allTracked) {
      // The puck is stationary on the desk; do NOT track it with optical flow.
      const px = trackPoints[0].x, py = trackPoints[0].y;
      
      const fx = p1.data32F[0], fy = p1.data32F[1];
      const bx = p1.data32F[2], by = p1.data32F[3];
      
      const cx = (fx + bx) / 2;
      const cy = (fy + by) / 2;

      if (isTracking.value) {
        // Draw optical flow tracking points (Controller Front and Back)
        ctx.fillStyle = "lime";
        for (let i = 0; i < 2; i++) {
          const ptX = p1.data32F[i*2];
          const ptY = p1.data32F[i*2+1];
          ctx.beginPath();
          ctx.arc(ptX, ptY, 5, 0, 2 * Math.PI);
          ctx.fill();
          
          ctx.fillStyle = "white";
          ctx.font = "bold 16px sans-serif";
          ctx.fillText((i + 2).toString(), ptX + 10, ptY + 10);
          ctx.fillStyle = "lime";
        }
        
        // Draw the stationary puck (Point 1)
        ctx.fillStyle = "yellow";
        ctx.beginPath();
        ctx.arc(px, py, 5, 0, 2 * Math.PI);
        ctx.fill();
        ctx.fillStyle = "white";
        ctx.font = "bold 16px sans-serif";
        ctx.fillText("1", px + 10, py + 10);
        
        // Draw target line
        ctx.strokeStyle = "#ffff00";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(px, py);
        ctx.stroke();

        // Draw oriented bounding boxes for genuine obstacles
        if (showNNOverlay.value && detector.result && detector.result.count > 0) {
          detector.result.obstacles.forEach((obs: any) => {
            const obsCx = obs.oriented_bbox.center_x;
            const obsCy = obs.oriented_bbox.center_y;
            
            // Filter out the Steam Controller itself! (If the obstacle center is within 80px of the optical flow center)
            const distToController = Math.sqrt((obsCx - cx)**2 + (obsCy - cy)**2);
            if (distToController < 80) return;
            
            const w = obs.oriented_bbox.width;
            const h = obs.oriented_bbox.height;
            const angle = obs.oriented_bbox.angle * Math.PI / 180;
            
            // Draw rotated bounding box
            ctx.save();
            ctx.translate(obsCx, obsCy);
            ctx.rotate(angle);
            ctx.strokeStyle = '#ff66b2';
            ctx.lineWidth = 2;
            ctx.strokeRect(-w/2, -h/2, w, h);
            ctx.restore();
            
            // Draw forward vector
            ctx.strokeStyle = '#ff66b2';
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.moveTo(obsCx, obsCy);
            ctx.lineTo(obsCx + Math.cos(angle) * (w/2 + 20), obsCy + Math.sin(angle) * (w/2 + 20));
            ctx.stroke();
            
            // Text
            ctx.fillStyle = '#ff66b2';
            ctx.font = '16px sans-serif';
            ctx.fillText(`#${obs.id} (${(obs.confidence * 100).toFixed(0)}%)`, obsCx - w/2, obsCy - h/2 - 5);
          });
        }
      }
      
      // Update p0 and oldGray for next frame
      p0.data32F.set(p1.data32F);
      oldGray.delete();
      oldGray = frameGray.clone();
      
      // Navigation
      if (isConnected.value) {
        const dx = px - cx;
        const dy = py - cy;
        const dist = Math.sqrt(dx*dx + dy*dy);
        let targetHeading = Math.atan2(dy, dx);
        
        const cHeading = Math.atan2(fy - by, fx - bx);
        
        // --- Obstacle Avoidance ---
        let avoidanceOverride = false;
        if (detector.result && detector.result.count > 0) {
          let closestObstacleDist = Infinity;
          let avoidHeading = targetHeading;

          for (const obs of detector.result.obstacles) {
            // Distance from controller to obstacle center
            const odx = obs.oriented_bbox.center_x - cx;
            const ody = obs.oriented_bbox.center_y - cy;
            const odist = Math.sqrt(odx * odx + ody * ody);
            
            // Only care about obstacles in front of us within a danger radius (e.g., 200px)
            // But ignore obstacles that are TOO close (odist < 80) because that is likely the controller detecting itself!
            if (odist < 200 && odist > 80) {
              const obsAngle = Math.atan2(ody, odx);
              let relativeAngle = obsAngle - cHeading;
              while (relativeAngle > Math.PI) relativeAngle -= 2 * Math.PI;
              while (relativeAngle < -Math.PI) relativeAngle += 2 * Math.PI;
              
              // If it's roughly in front (±60 deg)
              if (Math.abs(relativeAngle) < Math.PI / 3) {
                if (odist < closestObstacleDist) {
                  closestObstacleDist = odist;
                  
                  // Decide which way to avoid based on obstacle's principal orientation
                  // If the obstacle is slanted right, we go right, etc.
                  // (Orientation logic can be refined later, using simple avoidance for now)
                  
                  // Simple avoidance: push target heading 90 degrees away from the obstacle
                  // relative to our current heading, depending on which side it blocks more
                  if (relativeAngle > 0) {
                    // Obstacle is to our right, steer left
                    avoidHeading = cHeading - Math.PI / 2;
                  } else {
                    // Obstacle is to our left, steer right
                    avoidHeading = cHeading + Math.PI / 2;
                  }
                  avoidanceOverride = true;
                }
              }
            }
          }
          
          if (avoidanceOverride) {
            targetHeading = avoidHeading;
            // Draw avoidance vector
            if (showNNOverlay.value) {
              ctx.strokeStyle = 'magenta';
              ctx.lineWidth = 4;
              ctx.beginPath();
              ctx.moveTo(cx, cy);
              ctx.lineTo(cx + Math.cos(targetHeading) * 100, cy + Math.sin(targetHeading) * 100);
              ctx.stroke();
            }
          }
        }
        // --- End Obstacle Avoidance ---
        
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
        } else if (isFailed) {
          sendControl("STOP");
        } else if (dist < 35 || arrivalTime !== null) {
          if (arrivalTime === null) {
            arrivalTime = Date.now();
          }
          const now = Date.now();
          
          if (now - arrivalTime > 1000) {
            if (shimmyStartTime === null) {
              shimmyStartTime = now;
            }
            
            const elapsed = now - shimmyStartTime;
            let accumulated = 0;
            let currentPhase = -1;
            
            for (let i = 0; i < SHIMMY_DURATIONS.length; i++) {
              if (elapsed < accumulated + SHIMMY_DURATIONS[i]) {
                currentPhase = i;
                break;
              }
              accumulated += SHIMMY_DURATIONS[i];
            }
            
            if (currentPhase === -1) {
              isFailed = true;
              sendControl("STOP");
              statusMsg.value = "FAILED: Could not establish charging connection.";
            } else {
              if (currentPhase % 2 === 0) {
                sendControl("LEFT");
                statusMsg.value = `Shimmying Left (${Math.floor(currentPhase/2) + 1}/4)...`;
              } else {
                sendControl("RIGHT");
                statusMsg.value = `Shimmying Right (${Math.floor(currentPhase/2) + 1}/4)...`;
              }
            }
          } else {
            sendControl("STOP");
            statusMsg.value = "Arrived at puck! Waiting for charge...";
          }
        } else if (Math.abs(angleErr) > 0.3) {
          arrivalTime = null;
          shimmyStartTime = null;
          if (angleErr > 0) {
            sendControl("RIGHT");
            statusMsg.value = "Turning Right";
          } else {
            sendControl("LEFT");
            statusMsg.value = avoidanceOverride ? "Avoiding Obstacle (Left)!" : "Turning Left";
          }
        } else {
          arrivalTime = null;
          shimmyStartTime = null;
          // Slow down if getting close
          if (dist < 150 && !avoidanceOverride && Date.now() % 500 > 250) {
            sendControl("STOP");
            statusMsg.value = "Creeping Forward...";
          } else {
            sendControl("FORWARD");
            statusMsg.value = avoidanceOverride ? "Moving Forward (Avoidance)" : "Moving Forward";
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
  controller.eStop = false;
  if (videoRef.value) videoRef.value.play();
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
  
  if (videoRef.value && videoRef.value.srcObject) {
    const stream = videoRef.value.srcObject as MediaStream;
    stream.getTracks().forEach(track => track.stop());
  }
});

const resetTracking = async () => {
  await controller.stopAll();
  localStorage.removeItem('trackPoints');
  
  if (oldGray) { oldGray.delete(); oldGray = null; }
  if (p0) { p0.delete(); p0 = null; }
  
  isTracking.value = false;
  selectionStep = 0;
  trackPoints = [];
  controller.eStop = false;
  
  if (videoRef.value) videoRef.value.play();
  statusMsg.value = "Tracking reset. Click the Charging Puck to begin.";
  
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
  }
  processVideo();
};

const toggleAutoTrack = () => {
  if (autoTrackEngaged.value) {
    autoTrackEngaged.value = false;
    localStorage.removeItem('autoTrackEngaged');
    resetTracking();
  } else {
    autoTrackEngaged.value = true;
    localStorage.setItem('autoTrackEngaged', 'true');
    autoTrack();
  }
};

const stopController = async () => {
  controller.eStop = !controller.eStop;
  if (controller.eStop) {
    await controller.stopAll();
    statusMsg.value = "Emergency Stop Active! Tracking Halted.";
  } else {
    statusMsg.value = "Emergency Stop Lifted. Tracking Resumed.";
    processVideo(); // Kickstart the video loop again
  }
};

const saveScreenshot = () => {
  if (!canvasRef.value) return;
  const dataURL = canvasRef.value.toDataURL('image/png');
  const a = document.createElement('a');
  a.href = dataURL;
  const now = new Date();
  const timestamp = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}-${String(now.getMinutes()).padStart(2,'0')}-${String(now.getSeconds()).padStart(2,'0')}`;
  a.download = `Screenshot_${timestamp}.png`;
  a.click();
};

const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || window.location.hostname.endsWith('.local');

const autoTrack = async () => {
  if (!videoRef.value || !canvasRef.value) return;
  let cv = cvModule as any;
  if (cv instanceof Promise) cv = await cv;
  
  statusMsg.value = "Auto-tracking... Please hold still.";
  
  const pImg = new Image();
  pImg.src = "/puck.png";
  await new Promise(r => pImg.onload = r);
  
  const getMatFromImage = (img: HTMLImageElement) => {
    const canvas = document.createElement('canvas');
    canvas.width = img.width; canvas.height = img.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0);
    const mat = cv.imread(canvas);
    
    const channels = new cv.MatVector();
    cv.split(mat, channels);
    let alpha = null;
    if (channels.size() === 4) {
      alpha = channels.get(3).clone();
    } else {
      alpha = new cv.Mat(mat.rows, mat.cols, cv.CV_8UC1, new cv.Scalar(255));
    }
    
    const gray = new cv.Mat();
    cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY);
    
    channels.delete();
    mat.delete();
    return { gray, alpha };
  };
  
  const puckMats = getMatFromImage(pImg);
  const puckTemplate = puckMats.gray;
  const puckMask = puckMats.alpha;
  
  const ctx = canvasRef.value.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(videoRef.value, 0, 0, canvasRef.value.width, canvasRef.value.height);
  const imageData = ctx.getImageData(0, 0, canvasRef.value.width, canvasRef.value.height);
  const frame = cv.matFromImageData(imageData);
  const gray = new cv.Mat();
  cv.cvtColor(frame, gray, cv.COLOR_RGBA2GRAY);
  
  // 1. Find Puck using Multi-Scale Template Matching
  let bestPuckScore = -Infinity;
  let px = canvasRef.value.width / 2;
  let py = canvasRef.value.height / 4;
  
  const scales = [0.015, 0.02, 0.025, 0.03, 0.04, 0.05, 0.07, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1.0];
  for (const scale of scales) {
    const resizedPuck = new cv.Mat();
    cv.resize(puckTemplate, resizedPuck, new cv.Size(0, 0), scale, scale, cv.INTER_LINEAR);
    const resizedMask = new cv.Mat();
    cv.resize(puckMask, resizedMask, new cv.Size(0, 0), scale, scale, cv.INTER_NEAREST);
    
    if (resizedPuck.cols >= gray.cols || resizedPuck.rows >= gray.rows) {
      resizedPuck.delete();
      resizedMask.delete();
      continue;
    }
    let pResult = new cv.Mat();
    cv.matchTemplate(gray, resizedPuck, pResult, cv.TM_CCORR_NORMED, resizedMask);
    
    // The charging puck is always positioned at the top area of the desk.
    // Mask out the bottom half and extreme edges to prevent false positives from shadows.
    for (let y = 0; y < pResult.rows; y++) {
      for (let x = 0; x < pResult.cols; x++) {
         if (y > 220 || y < 100 || x < 150 || x > 400) {
           pResult.floatPtr(y, x)[0] = 0;
         }
      }
    }

    let pMinMax = cv.minMaxLoc(pResult);
    if (pMinMax.maxVal > bestPuckScore) {
      bestPuckScore = pMinMax.maxVal;
      
      // The puck coordinate targeted by the user is near the top-left of the matched template.
      px = pMinMax.maxLoc.x + (resizedPuck.cols * 0.28);
      py = pMinMax.maxLoc.y + (resizedPuck.rows * 0.16);
    }
    resizedPuck.delete();
    resizedMask.delete();
    pResult.delete();
  }
  
  // 2. Find Controller using the highly robust WASM CNN!
  let cObstacle = null;
  if (detector.result && detector.result.count > 0) {
    let maxArea = 0;
    for (const obs of detector.result.obstacles) {
      const area = obs.oriented_bbox.width * obs.oriented_bbox.height;
      if (area > maxArea) {
        maxArea = area;
        cObstacle = obs;
      }
    }
  }
  
  let fx = 0, fy = 0, bx = 0, by = 0;
  if (cObstacle) {
    const cx = cObstacle.oriented_bbox.center_x;
    const cy = cObstacle.oriented_bbox.center_y;
    const angleRad = cObstacle.oriented_bbox.angle * Math.PI / 180;
    const width = cObstacle.oriented_bbox.width;
    
    // Front dot (Steam Logo) is slightly forward
    fx = cx + Math.cos(angleRad) * width * 0.025;
    fy = cy + Math.sin(angleRad) * width * 0.025;
    
    // Back dot (Share button) is further backward
    bx = cx - Math.cos(angleRad) * width * 0.42;
    by = cy - Math.sin(angleRad) * width * 0.42;
  } else {
    fx = canvasRef.value.width / 2;
    fy = canvasRef.value.height / 2 + 20;
    bx = canvasRef.value.width / 2;
    by = canvasRef.value.height / 2 - 20;
    console.warn("CNN could not find the controller.");
  }
  
  trackPoints = [
    { x: px, y: py },
    { x: fx, y: fy },
    { x: bx, y: by }
  ];
  
  selectionStep = 3;
  statusMsg.value = "Auto-Track complete! Tracking started!";
  localStorage.setItem('trackPoints', JSON.stringify(trackPoints));
  isTracking.value = true;
  
  frame.delete();
  gray.delete();
  puckTemplate.delete();
  puckMask.delete();
  
  initOpticalFlow();
};

</script>

<template>
  <div class="app-container">
    <header class="masthead">
      <h1>Steam Controller Auto-Charge</h1>
      <p class="status">{{ statusMsg }}</p>
      
      <StatusBar v-if="isConnected" :controller="controller" />

      <div class="controls">
        <button @click="stopController" class="btn-stop" :class="{ 'is-active': controller.eStop }" title="Emergency Stop">
          🛑
        </button>
        <button v-if="isLocal" @click="saveScreenshot" class="btn-cta" style="background: #555;" title="Save Debug Screenshot">
          📸
        </button>
        <button @click="showNNOverlay = !showNNOverlay" class="btn-cta" style="background: #555;" title="Toggle NN Overlay">
          🧠
        </button>
        <button @click="connectHID" :disabled="isConnected" class="btn-cta">
          {{ isConnected ? 'Controller Linked' : 'Connect Steam Controller' }}
        </button>
        <button v-if="isConnected" @click="toggleAutoTrack" class="btn-cta" :style="{ background: autoTrackEngaged ? '#8e44ad' : '#555' }">
          ✨ Auto-Track
        </button>
        <button v-if="selectionStep === 3" @click="resetTracking" class="btn-reset" title="Reset Tracking">
          🔄
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
        <li>Place the controller upright on the desk.</li>
        <li>Click <strong>✨ Auto-Track</strong> to engage automatic tracking. Click it again to disengage.</li>
        <li>(Alternatively, manually click the Puck, then the Steam button, then the Share button).</li>
      </ol>
      <p>The app will automatically locate the controller and puck on reload if Auto-Track is engaged.</p>
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
.btn-cta, .btn-reset, .btn-stop {
  background: #3498db;
  color: white;
  border: none;
  padding: 10px 20px;
  border-radius: 5px;
  font-size: 1.2rem;
  cursor: pointer;
  transition: background 0.2s;
  margin: 0 10px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.btn-reset {
  background: #e74c3c;
}
.btn-stop {
  background: #555;
  font-weight: bold;
}
.btn-cta:hover:not(:disabled) {
  background: #2980b9;
}
.btn-reset:hover {
  background: #c0392b;
}
.btn-stop:hover {
  background: #666;
}
.btn-stop.is-active {
  background: #c0392b;
}
.btn-stop.is-active:hover {
  background: #a93226;
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
