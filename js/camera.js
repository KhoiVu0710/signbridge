// Camera + MediaPipe Holistic, entirely in the browser. Settings match
// vision/voya_features.create_voya_detector (legacy Holistic, complexity 0,
// no face refinement). Frames are processed unmirrored, like VOYA; only the
// on-screen preview may be mirrored with CSS.
import { assembleFrame } from "./recognizer.js";

const HAND_LINKS = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];
const POSE_LINKS = [[11,12],[11,13],[13,15],[12,14],[14,16],[11,23],[12,24],[23,24]];

let holisticPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Không tải được ${src}`));
    document.head.append(script);
  });
}

async function getHolistic() {
  if (!holisticPromise) {
    holisticPromise = (async () => {
      await loadScript("vendor/holistic/holistic.js");
      const holistic = new window.Holistic({ locateFile: (file) => `vendor/holistic/${file}` });
      holistic.setOptions({
        modelComplexity: 0,
        smoothLandmarks: true,
        enableSegmentation: false,
        refineFaceLandmarks: false,
        minDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
      await holistic.initialize();
      return holistic;
    })();
    holisticPromise.catch(() => { holisticPromise = null; });
  }
  return holisticPromise;
}

export class SignCamera {
  constructor({ video, canvas, onFrame, onStatus }) {
    this.video = video;
    this.canvas = canvas;
    this.onFrame = onFrame;
    this.onStatus = onStatus;
    this.running = false;
    this.times = [];
  }

  get fps() {
    if (this.times.length < 10) return null;
    const span = (this.times.at(-1) - this.times[0]) / 1000;
    return span > 0 ? (this.times.length - 1) / span : null;
  }

  async start() {
    if (this.running) return;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("no-camera-api");
    this.onStatus?.("loading");
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 30 }, facingMode: "user" },
      audio: false,
    });
    this.video.srcObject = this.stream;
    await this.video.play();
    const holistic = await getHolistic();
    holistic.onResults((results) => this.handle(results));
    this.holistic = holistic;
    this.running = true;
    this.onStatus?.("running");
    this.loop();
  }

  async loop() {
    while (this.running) {
      if (this.video.readyState >= 2) {
        try {
          await this.holistic.send({ image: this.video });
        } catch (error) {
          this.onStatus?.("error", error);
          this.stop();
          return;
        }
      }
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  }

  handle(results) {
    if (!this.running) return;
    this.times.push(performance.now());
    if (this.times.length > 30) this.times.shift();
    const { frame, hand, pose } = assembleFrame(results);
    this.draw(results);
    this.onFrame?.(frame, hand, pose);
  }

  draw(results) {
    const { canvas, video } = this;
    if (!canvas) return;
    const width = video.videoWidth || 640, height = video.videoHeight || 480;
    if (canvas.width !== width) { canvas.width = width; canvas.height = height; }
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, width, height);
    const line = (points, links, color, size) => {
      if (!points) return;
      ctx.strokeStyle = color; ctx.lineWidth = size; ctx.lineCap = "round";
      for (const [a, b] of links) {
        if (!points[a] || !points[b]) continue;
        ctx.beginPath();
        ctx.moveTo(points[a].x * width, points[a].y * height);
        ctx.lineTo(points[b].x * width, points[b].y * height);
        ctx.stroke();
      }
      ctx.fillStyle = color;
      for (const p of points) { if (p) { ctx.beginPath(); ctx.arc(p.x * width, p.y * height, size, 0, Math.PI * 2); ctx.fill(); } }
    };
    line(results.poseLandmarks?.slice(0, 25), POSE_LINKS, "rgba(255,255,255,.55)", 3);
    line(results.leftHandLandmarks, HAND_LINKS, "#7FB2FF", 3);
    line(results.rightHandLandmarks, HAND_LINKS, "#FFD36B", 3);
  }

  stop() {
    this.running = false;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.times = [];
    this.canvas?.getContext("2d").clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.onStatus?.("stopped");
  }
}
