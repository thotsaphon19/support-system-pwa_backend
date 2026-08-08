/* avatar-renderer.js
 *
 * Renders an animated avatar (a canvas MediaStream) driven by REAL, live face tracking
 * of the person's camera feed — using Google's MediaPipe FaceLandmarker running entirely
 * in the browser. The avatar blinks, talks, smiles, and turns its head based on the
 * person's actual expressions and head pose in real time. Same category of technology as
 * VTuber apps, Zoom/Teams avatars, and Memoji.
 *
 * This intentionally does NOT attempt photorealistic face-swapping or identity synthesis —
 * it draws a shaded, semi-dimensional illustrated character, not a likeness of any real
 * face. That's a deliberate scope boundary, not a technical limitation: real-time synthesis
 * of a photorealistic human face is deepfake-adjacent identity-synthesis technology, and
 * building that isn't something done here regardless of the legitimate use case behind it.
 *
 * Usage:
 *   const avatar = await createAvatarStream(sourceVideoEl, {
 *     skinTone: '#F0C8A0', hairColor: '#3A2A20', uniformColor: '#6C3CE9'
 *   });
 *   someVideoTrack = avatar.stream.getVideoTracks()[0];
 *   avatar.stop();
 */

async function createAvatarStream(sourceVideoEl, options = {}) {
  const { FaceLandmarker, FilesetResolver } = await import(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs'
  );

  const fileset = await FilesetResolver.forVisionTasks(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
  );

  const faceLandmarker = await FaceLandmarker.createFromOptions(fileset, {
    baseOptions: {
      modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
      delegate: 'GPU',
    },
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
    runningMode: 'VIDEO',
    numFaces: 1,
  });

  const size = options.size || 480;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  const palette = {
    skin: options.skinTone || '#F0C8A0',
    hair: options.hairColor || '#3A2A20',
    uniform: options.uniformColor || '#6C3CE9',
  };

  let running = true;
  let lastVideoTime = -1;

  // Smoothed head-pose state (low-pass filtered so tracking noise doesn't cause jitter).
  const pose = { yaw: 0, pitch: 0, roll: 0 };
  // Idle "breathing" motion so the avatar isn't perfectly frozen when the face is still.
  let idlePhase = 0;

  function scoreOf(categories, name) {
    const c = categories && categories.find((x) => x.categoryName === name);
    return c ? c.score : 0;
  }

  // Decomposes the 4x4 facial transformation matrix (column-major, OpenGL-style) MediaPipe
  // returns into approximate yaw/pitch/roll. This is a cosmetic head-turn effect, not a
  // precision measurement, so exact axis calibration isn't critical — small/damped is fine.
  function decomposeRotation(matrixData) {
    const m = matrixData;
    const r02 = m[8], r12 = m[9], r22 = m[10], r10 = m[1], r11 = m[5];
    const yaw = Math.atan2(r02, r22);
    const pitch = Math.atan2(-r12, Math.sqrt(r02 * r02 + r22 * r22));
    const roll = Math.atan2(r10, r11);
    return { yaw, pitch, roll };
  }

  function lighten(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    const r = Math.min(255, Math.max(0, (n >> 16) + amt));
    const g = Math.min(255, Math.max(0, ((n >> 8) & 0xff) + amt));
    const b = Math.min(255, Math.max(0, (n & 0xff) + amt));
    return `rgb(${r},${g},${b})`;
  }
  function darken(hex, amt) { return lighten(hex, -amt); }

  function drawAvatar(blendshapes, rawPose) {
    // Low-pass filter the head pose so it eases toward the target instead of snapping.
    pose.yaw += (rawPose.yaw - pose.yaw) * 0.15;
    pose.pitch += (rawPose.pitch - pose.pitch) * 0.15;
    pose.roll += (rawPose.roll - pose.roll) * 0.15;
    idlePhase += 0.02;

    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const faceR = size * 0.27;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Background
    const bg = ctx.createLinearGradient(0, 0, 0, canvas.height);
    bg.addColorStop(0, '#5A3BD6');
    bg.addColorStop(1, '#3B2593');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const jawOpen = blendshapes ? scoreOf(blendshapes, 'jawOpen') : 0;
    const blinkL = blendshapes ? scoreOf(blendshapes, 'eyeBlinkLeft') : 0;
    const blinkR = blendshapes ? scoreOf(blendshapes, 'eyeBlinkRight') : 0;
    const smileL = blendshapes ? scoreOf(blendshapes, 'mouthSmileLeft') : 0;
    const smileR = blendshapes ? scoreOf(blendshapes, 'mouthSmileRight') : 0;
    const smile = (smileL + smileR) / 2;
    const browUp = blendshapes ? scoreOf(blendshapes, 'browInnerUp') : 0;
    const browDownL = blendshapes ? scoreOf(blendshapes, 'browDownLeft') : 0;
    const browDownR = blendshapes ? scoreOf(blendshapes, 'browDownRight') : 0;

    ctx.save();
    ctx.translate(cx, cy + size * 0.06 + Math.sin(idlePhase) * 1.5);
    // Head-turn parallax: shift + squash horizontally with yaw, tilt with roll, nod with pitch.
    ctx.rotate(pose.roll * 0.5);
    ctx.translate(pose.yaw * size * 0.12, -pose.pitch * size * 0.06);
    ctx.scale(1 - Math.abs(pose.yaw) * 0.18, 1 + pose.pitch * 0.05);

    // --- Shoulders / uniform (grounds the head, adds depth) ---
    ctx.fillStyle = darken(palette.uniform, 10);
    ctx.beginPath();
    ctx.moveTo(-faceR * 1.9, size * 0.62);
    ctx.quadraticCurveTo(0, faceR * 0.55, faceR * 1.9, size * 0.62);
    ctx.lineTo(faceR * 1.9, size * 0.7);
    ctx.lineTo(-faceR * 1.9, size * 0.7);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = palette.uniform;
    ctx.beginPath();
    ctx.moveTo(-faceR * 1.7, size * 0.63);
    ctx.quadraticCurveTo(0, faceR * 0.48, faceR * 1.7, size * 0.63);
    ctx.lineTo(faceR * 1.7, size * 0.7);
    ctx.lineTo(-faceR * 1.7, size * 0.7);
    ctx.closePath();
    ctx.fill();

    // --- Neck ---
    ctx.fillStyle = darken(palette.skin, 14);
    ctx.fillRect(-faceR * 0.32, faceR * 0.35, faceR * 0.64, faceR * 0.55);

    // --- Back hair (behind face, for depth) ---
    ctx.fillStyle = darken(palette.hair, 12);
    ctx.beginPath();
    ctx.arc(0, -faceR * 0.05, faceR * 1.12, Math.PI * 0.95, Math.PI * 2.05);
    ctx.fill();

    // --- Ears ---
    ctx.fillStyle = palette.skin;
    [-1, 1].forEach((side) => {
      ctx.beginPath();
      ctx.ellipse(side * faceR * 0.98, 0, faceR * 0.11, faceR * 0.16, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = darken(palette.skin, 18);
      ctx.beginPath();
      ctx.ellipse(side * faceR * 0.98, faceR * 0.02, faceR * 0.045, faceR * 0.08, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = palette.skin;
    });

    // --- Face (radial gradient for volume) ---
    const faceGrad = ctx.createRadialGradient(-faceR * 0.3, -faceR * 0.35, faceR * 0.2, 0, 0, faceR * 1.15);
    faceGrad.addColorStop(0, lighten(palette.skin, 18));
    faceGrad.addColorStop(0.65, palette.skin);
    faceGrad.addColorStop(1, darken(palette.skin, 20));
    ctx.fillStyle = faceGrad;
    ctx.beginPath();
    ctx.arc(0, 0, faceR, 0, Math.PI * 2);
    ctx.fill();

    // Cheek blush (stronger with smile)
    ctx.fillStyle = `rgba(240,57,140,${0.1 + smile * 0.2})`;
    [-1, 1].forEach((side) => {
      ctx.beginPath();
      ctx.ellipse(side * faceR * 0.58, faceR * 0.22, faceR * 0.17, faceR * 0.1, 0, 0, Math.PI * 2);
      ctx.fill();
    });

    // --- Front hair / fringe ---
    ctx.fillStyle = palette.hair;
    ctx.beginPath();
    ctx.moveTo(-faceR * 1.05, -faceR * 0.15);
    ctx.quadraticCurveTo(-faceR * 0.6, -faceR * 1.25, 0, -faceR * 1.15);
    ctx.quadraticCurveTo(faceR * 0.6, -faceR * 1.25, faceR * 1.05, -faceR * 0.15);
    ctx.quadraticCurveTo(faceR * 0.5, -faceR * 0.55, 0, -faceR * 0.5);
    ctx.quadraticCurveTo(-faceR * 0.5, -faceR * 0.55, -faceR * 1.05, -faceR * 0.15);
    ctx.closePath();
    ctx.fill();
    // hair shine
    ctx.fillStyle = `rgba(255,255,255,0.12)`;
    ctx.beginPath();
    ctx.ellipse(-faceR * 0.25, -faceR * 0.85, faceR * 0.35, faceR * 0.1, -0.3, 0, Math.PI * 2);
    ctx.fill();

    // --- Eyebrows (curved, react to browUp / browDown) ---
    ctx.strokeStyle = palette.hair;
    ctx.lineWidth = size * 0.016;
    ctx.lineCap = 'round';
    [-1, 1].forEach((side) => {
      const down = side < 0 ? browDownL : browDownR;
      const y = -faceR * 0.22 - browUp * faceR * 0.1 + down * faceR * 0.08;
      ctx.beginPath();
      ctx.moveTo(side * faceR * 0.15, y + 4);
      ctx.quadraticCurveTo(side * faceR * 0.38, y - faceR * 0.08, side * faceR * 0.55, y + 2);
      ctx.stroke();
    });

    // --- Eyes (sclera + iris + pupil + highlight, close with blink) ---
    const eyeY = -faceR * 0.02;
    [-1, 1].forEach((side) => {
      const openness = 1 - (side < 0 ? blinkL : blinkR);
      const eh = Math.max(1.2, faceR * 0.13 * openness);
      const ex = side * faceR * 0.4;

      ctx.fillStyle = '#FFFFFF';
      ctx.beginPath();
      ctx.ellipse(ex, eyeY, faceR * 0.15, eh, 0, 0, Math.PI * 2);
      ctx.fill();

      if (openness > 0.15) {
        ctx.fillStyle = '#3B2A20';
        ctx.beginPath();
        ctx.arc(ex + pose.yaw * faceR * 0.08, eyeY, faceR * 0.075 * Math.min(1, openness + 0.3), 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#151015';
        ctx.beginPath();
        ctx.arc(ex + pose.yaw * faceR * 0.08, eyeY, faceR * 0.035 * Math.min(1, openness + 0.3), 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.beginPath();
        ctx.arc(ex + pose.yaw * faceR * 0.08 - faceR * 0.02, eyeY - faceR * 0.03, faceR * 0.018, 0, Math.PI * 2);
        ctx.fill();
      }

      // Upper eyelid line for definition
      ctx.strokeStyle = darken(palette.skin, 30);
      ctx.lineWidth = size * 0.006;
      ctx.beginPath();
      ctx.ellipse(ex, eyeY, faceR * 0.15, eh, 0, Math.PI, Math.PI * 2);
      ctx.stroke();
    });

    // --- Nose (very subtle shading, not a hard outline) ---
    ctx.strokeStyle = `rgba(0,0,0,0.08)`;
    ctx.lineWidth = size * 0.008;
    ctx.beginPath();
    ctx.moveTo(-faceR * 0.03, faceR * 0.05);
    ctx.quadraticCurveTo(-faceR * 0.06, faceR * 0.22, 0, faceR * 0.26);
    ctx.stroke();
    ctx.fillStyle = `rgba(0,0,0,0.06)`;
    [-1, 1].forEach((side) => {
      ctx.beginPath();
      ctx.ellipse(side * faceR * 0.045, faceR * 0.27, faceR * 0.025, faceR * 0.015, 0, 0, Math.PI * 2);
      ctx.fill();
    });

    // --- Mouth (opens with jawOpen, shows teeth hint when wide open, else a smile curve) ---
    const mouthY = faceR * 0.52;
    const mouthW = faceR * (0.32 + smile * 0.14);
    if (jawOpen > 0.1) {
      const mouthH = faceR * 0.06 + jawOpen * faceR * 0.32;
      ctx.fillStyle = '#5A2A2A';
      ctx.beginPath();
      ctx.ellipse(0, mouthY, mouthW, mouthH, 0, 0, Math.PI * 2);
      ctx.fill();
      if (jawOpen > 0.35) {
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.beginPath();
        ctx.ellipse(0, mouthY - mouthH * 0.55, mouthW * 0.75, mouthH * 0.28, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.strokeStyle = darken(palette.skin, 25);
      ctx.lineWidth = size * 0.008;
      ctx.beginPath();
      ctx.ellipse(0, mouthY, mouthW, mouthH, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      ctx.strokeStyle = '#8B4A4A';
      ctx.lineWidth = size * 0.014;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-mouthW, mouthY - smile * faceR * 0.02);
      ctx.quadraticCurveTo(0, mouthY + faceR * 0.06 + smile * faceR * 0.12, mouthW, mouthY - smile * faceR * 0.02);
      ctx.stroke();
    }

    // Subtle vignette for a bit more dimension at the face edges
    const vignette = ctx.createRadialGradient(0, 0, faceR * 0.6, 0, 0, faceR * 1.15);
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(1, 'rgba(0,0,0,0.12)');
    ctx.fillStyle = vignette;
    ctx.beginPath();
    ctx.arc(0, 0, faceR, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  function loop() {
    if (!running) return;
    if (sourceVideoEl.readyState >= 2 && sourceVideoEl.currentTime !== lastVideoTime) {
      lastVideoTime = sourceVideoEl.currentTime;
      const result = faceLandmarker.detectForVideo(sourceVideoEl, performance.now());
      const blendshapes = result.faceBlendshapes && result.faceBlendshapes[0] ? result.faceBlendshapes[0].categories : null;
      let rawPose = { yaw: 0, pitch: 0, roll: 0 };
      if (result.facialTransformationMatrixes && result.facialTransformationMatrixes[0]) {
        rawPose = decomposeRotation(result.facialTransformationMatrixes[0].data);
      }
      drawAvatar(blendshapes, rawPose);
    }
    requestAnimationFrame(loop);
  }
  loop();

  const stream = canvas.captureStream(24);
  return {
    stream,
    canvas,
    stop() {
      running = false;
      try { faceLandmarker.close(); } catch (e) { /* noop */ }
    },
  };
}

window.createAvatarStream = createAvatarStream;
