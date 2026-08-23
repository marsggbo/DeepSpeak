/* 录音器：16kHz 单声道 PCM → WAV（浏览器原生，无需 MediaRecorder 容器转换）。 */
(function () {
  "use strict";

  function Recorder() {
    this.ctx = null;
    this.stream = null;
    this.recording = false;
    this.chunks = [];
    this.timer = null;
    this.elapsed = 0;
    this.onTick = null;
    this.onDone = null;   // (base64Wav, seconds)
    this.onError = null;
  }

  Recorder.prototype.start = function (opts) {
    var self = this;
    opts = opts || {};
    this.onTick = opts.onTick || null;
    this.onDone = opts.onDone || null;
    this.onError = opts.onError || null;
    this.maxSeconds = opts.maxSeconds || 30;

    navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
      .then(function (stream) {
        self.stream = stream;
        try {
          var Ctx = window.AudioContext || window.webkitAudioContext;
          self.ctx = new Ctx();
          var src = self.ctx.createMediaStreamSource(stream);
          var node = self.ctx.createScriptProcessor(4096, 1, 1);
          node.onaudioprocess = function (e) {
            if (!self.recording) return;
            var input = e.inputBuffer.getChannelData(0);
            // 降采样到 16kHz（以实际输入采样率计算，ctx.sampleRate 是只读属性）
            var ratio = e.inputBuffer.sampleRate / 16000;
            var out = new Float32Array(Math.floor(input.length / ratio));
            for (var i = 0; i < out.length; i++) {
              var idx = Math.floor(i * ratio);
              out[i] = input[idx];
            }
            self.chunks.push(out);
          };
          src.connect(node);
          node.connect(self.ctx.destination);
          self.recording = true;
          self.elapsed = 0;
          self.timer = setInterval(function () {
            self.elapsed += 0.1;
            if (self.onTick) self.onTick(Math.min(self.elapsed, self.maxSeconds));
            if (self.elapsed >= self.maxSeconds) self.stop();
          }, 100);
        } catch (err) {
          self._release();
          if (self.onError) self.onError("无法访问麦克风: " + (err && err.message || err));
        }
      })
      .catch(function (err) {
        if (self.onError) self.onError("无法访问麦克风: " + (err && err.message || err));
      });
  };

  Recorder.prototype._release = function () {
    if (this.stream) this.stream.getTracks().forEach(function (t) { t.stop(); });
    if (this.ctx) this.ctx.close();
    this.recording = false;
    if (this.timer) clearInterval(this.timer);
  };

  Recorder.prototype.stop = function () {
    if (!this.recording) return;
    this.recording = false;
    if (this.timer) clearInterval(this.timer);
    if (this.stream) this.stream.getTracks().forEach(function (t) { t.stop(); });
    if (this.ctx) this.ctx.close();
    var self = this;
    var total = 0;
    for (var i = 0; i < this.chunks.length; i++) total += this.chunks[i].length;
    var merged = new Float32Array(total);
    var off = 0;
    for (var j = 0; j < this.chunks.length; j++) {
      merged.set(this.chunks[j], off);
      off += this.chunks[j].length;
    }
    this.chunks = [];
    var seconds = total / 16000;
    var wav = encodeWav(merged, 16000);
    // blobToBase64 是异步的（FileReader），必须等它 resolve 再回调，
    // 否则回调收到 Promise 对象，序列化后是 {}，后端报"缺少音频数据"。
    blobToBase64(wav).then(function (b64) {
      if (self.onDone) self.onDone(b64, seconds);
    });
  };

  function encodeWav(samples, sampleRate) {
    var n = samples.length;
    var buf = new ArrayBuffer(44 + n * 2);
    var dv = new DataView(buf);
    function wstr(o, s) { for (var i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); }
    wstr(0, "RIFF"); dv.setUint32(4, 36 + n * 2, true); wstr(8, "WAVE");
    wstr(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
    dv.setUint16(22, 1, true); dv.setUint32(24, sampleRate, true);
    dv.setUint32(28, sampleRate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
    wstr(36, "data"); dv.setUint32(40, n * 2, true);
    for (var i = 0; i < n; i++) {
      var s = Math.max(-1, Math.min(1, samples[i]));
      dv.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
    return new Blob([buf], { type: "audio/wav" });
  }

  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () {
        var b64 = String(fr.result).split(",")[1] || "";
        resolve(b64);
      };
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });
  }

  window.Recorder = Recorder;
})();
