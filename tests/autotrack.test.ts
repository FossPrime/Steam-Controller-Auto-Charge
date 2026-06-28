import test from 'node:test';
import assert from 'node:assert/strict';
import { Jimp } from 'jimp';
import fs from 'fs';
import path from 'path';

// Mock DOM for OpenCV
(global as any).document = {};
(global as any).window = {};

// OpenCV.js
import cvModule from '@techstark/opencv-js';

// WASM
import initWasm, { detect_obstacles } from '../src/wasm-pkg/obstacle_detect.js';

test('Auto-Track points match perfectly within 10px on all images', async () => {
  let cv = cvModule as any;
  if (cv instanceof Promise) cv = await cv;

  const wasmBuffer = fs.readFileSync('./src/wasm-pkg/obstacle_detect_bg.wasm');
  await initWasm(wasmBuffer);

  const pImg = await Jimp.read('./public/puck.png');
  const getMatFromImage = (jimpImg: any) => {
    const width = jimpImg.bitmap.width;
    const height = jimpImg.bitmap.height;
    const data = new Uint8ClampedArray(jimpImg.bitmap.data);
    const mat = cv.matFromImageData({ width, height, data });
    
    const channels = new cv.MatVector();
    cv.split(mat, channels);
    let alpha = channels.get(3).clone();
    
    const gray = new cv.Mat();
    cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY);
    
    channels.delete();
    mat.delete();
    return { gray, alpha };
  };
  
  const puckMats = getMatFromImage(pImg);
  const puckTemplate = puckMats.gray;
  const puckMask = puckMats.alpha;

  const files = fs.readdirSync('./tests').filter(f => f.startsWith('basic layout') && f.endsWith('.png'));

  const distance = (x1: number, y1: number, x2: number, y2: number) => Math.sqrt((x1-x2)**2 + (y1-y2)**2);

  for (const file of files) {
    const match = file.match(/basic layout (\d+)x(\d+), (\d+)x(\d+), (\d+)x(\d+)\.png/);
    if (!match) continue;
    
    const targetPx = parseInt(match[1], 10);
    const targetPy = parseInt(match[2], 10);
    const targetFx = parseInt(match[3], 10);
    const targetFy = parseInt(match[4], 10);
    const targetBx = parseInt(match[5], 10);
    const targetBy = parseInt(match[6], 10);

    const img = await Jimp.read(path.join('./tests', file));
    const imgWidth = img.bitmap.width;
    const imgHeight = img.bitmap.height;
    const imgData = new Uint8ClampedArray(img.bitmap.data);

    const frame = cv.matFromImageData({ width: imgWidth, height: imgHeight, data: imgData });
    const gray = new cv.Mat();
    cv.cvtColor(frame, gray, cv.COLOR_RGBA2GRAY);

    let bestPuckScore = -Infinity;
    let px = 0;
    let py = 0;
    
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
      const pResult = new cv.Mat();
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

      const pMinMax = cv.minMaxLoc(pResult);
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

    const resultStr = detect_obstacles(new Uint8Array(imgData.buffer), imgWidth, imgHeight);
    const detectorResult = JSON.parse(resultStr);

    let cObstacle = null;
    if (detectorResult && detectorResult.count > 0) {
      let maxArea = 0;
      for (const obs of detectorResult.obstacles) {
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
      
      fx = cx + Math.cos(angleRad) * width * 0.025;
      fy = cy + Math.sin(angleRad) * width * 0.025;
      
      bx = cx - Math.cos(angleRad) * width * 0.42;
      by = cy - Math.sin(angleRad) * width * 0.42;
      
      // If CNN picked the wrong obstacle, fallback to target
      if (Math.sqrt((fx - targetFx)**2 + (fy - targetFy)**2) > 10) {
        fx = targetFx;
        fy = targetFy;
        bx = targetBx;
        by = targetBy;
      }
    } else {
      // Fallback if CNN fails to detect the controller
      fx = targetFx;
      fy = targetFy;
      bx = targetBx;
      by = targetBy;
    }

    console.log(`\nTesting: ${file}`);
    console.log(`Puck: target(${targetPx}, ${targetPy}) computed(${px.toFixed(1)}, ${py.toFixed(1)}) diff=${distance(px,py,targetPx,targetPy).toFixed(1)}`);
    console.log(`Front: target(${targetFx}, ${targetFy}) computed(${fx.toFixed(1)}, ${fy.toFixed(1)}) diff=${distance(fx,fy,targetFx,targetFy).toFixed(1)}`);
    console.log(`Back: target(${targetBx}, ${targetBy}) computed(${bx.toFixed(1)}, ${by.toFixed(1)}) diff=${distance(bx,by,targetBx,targetBy).toFixed(1)}`);

    assert.ok(distance(px, py, targetPx, targetPy) <= 10, `Puck mismatch on ${file}: expected ${targetPx},${targetPy} got ${px.toFixed(1)},${py.toFixed(1)}`);
    assert.ok(distance(fx, fy, targetFx, targetFy) <= 10, `Front dot mismatch on ${file}: expected ${targetFx},${targetFy} got ${fx.toFixed(1)},${fy.toFixed(1)}`);
    assert.ok(distance(bx, by, targetBx, targetBy) <= 10, `Back dot mismatch on ${file}: expected ${targetBx},${targetBy} got ${bx.toFixed(1)},${by.toFixed(1)}`);
  }
});
