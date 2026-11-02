// Throughline Speech: on-device speech recognition for voice mode (#11).
//
// Listens to the microphone, or reads an audio file with --file, and writes one JSON object per line to stdout:
//   {"type":"ready"}                      listening has started
//   {"type":"level","value":0.4}          microphone level, 0 to 1, a few times a second
//   {"type":"partial","text":"…"}         the transcript so far
//   {"type":"final","text":"…"}           the finished transcript, then the helper exits
//   {"type":"error","code":"…","message":"…"}
// --check reports permission and on-device availability without asking for anything. Listening stops when stdin
// receives "stop" or closes. Recognition always runs on this Mac (requiresOnDeviceRecognition): audio never leaves it.
//
// macOS asks for the microphone and speech recognition on behalf of the app responsible for a process. The helper
// relaunches itself as its own responsible process, so the request names "Throughline Speech" and uses the usage
// descriptions embedded in this binary, whichever app started it.
import AVFoundation
import Darwin
import Foundation
import Speech

setvbuf(stdout, nil, _IOLBF, 0)

func emit(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object), let line = String(data: data, encoding: .utf8) else { return }
  FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
}
func fail(_ code: String, _ message: String) -> Never { emit(["type": "error", "code": code, "message": message]); exit(2) }
func option(_ name: String) -> String? {
  let arguments = CommandLine.arguments
  guard let index = arguments.firstIndex(of: name), index + 1 < arguments.count else { return nil }
  return arguments[index + 1]
}

// MARK: Running as its own responsible process

var child: pid_t = 0
func relaunchDisclaimed() {
  if ProcessInfo.processInfo.environment["THROUGHLINE_SPEECH_CHILD"] != nil { return }
  typealias Disclaim = @convention(c) (UnsafeMutablePointer<posix_spawnattr_t?>, Int32) -> Int32
  guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_spawnattrs_setdisclaim"), let path = Bundle.main.executablePath else { return }
  var attributes: posix_spawnattr_t?
  posix_spawnattr_init(&attributes)
  defer { posix_spawnattr_destroy(&attributes) }
  _ = unsafeBitCast(symbol, to: Disclaim.self)(&attributes, 1)
  var environment = ProcessInfo.processInfo.environment
  environment["THROUGHLINE_SPEECH_CHILD"] = "1"
  let argv = CommandLine.arguments.map { strdup($0) } + [nil]
  let envp = environment.map { strdup("\($0.key)=\($0.value)") } + [nil]
  guard posix_spawn(&child, path, nil, &attributes, argv, envp) == 0 else { return }
  // Stopping or quitting the helper stops the relaunched copy too; stdin and stdout are shared with it.
  for signalNumber in [SIGTERM, SIGINT, SIGHUP] { signal(signalNumber) { received in kill(child, received) } }
  var status: Int32 = 0
  while waitpid(child, &status, 0) == -1 && errno == EINTR {}
  exit((status & 0x7f) == 0 ? (status >> 8) & 0xff : 1)
}
relaunchDisclaimed()

// MARK: Permissions

func name(_ status: SFSpeechRecognizerAuthorizationStatus) -> String {
  switch status { case .authorized: return "authorized"; case .denied: return "denied"; case .restricted: return "restricted"; default: return "not-determined" }
}
func name(_ status: AVAuthorizationStatus) -> String {
  switch status { case .authorized: return "authorized"; case .denied: return "denied"; case .restricted: return "restricted"; default: return "not-determined" }
}
let locale = Locale(identifier: option("--locale") ?? Locale.current.identifier)
guard let recognizer = SFSpeechRecognizer(locale: locale) else { fail("language", "Speech recognition isn't available for \(locale.identifier).") }

if CommandLine.arguments.contains("--check") {
  emit(["type": "check", "speech": name(SFSpeechRecognizer.authorizationStatus()), "microphone": name(AVCaptureDevice.authorizationStatus(for: .audio)), "onDevice": recognizer.supportsOnDeviceRecognition, "available": recognizer.isAvailable, "locale": recognizer.locale.identifier])
  exit(0)
}

let asked = DispatchSemaphore(value: 0)
var speech = SFSpeechRecognizer.authorizationStatus()
if speech == .notDetermined { SFSpeechRecognizer.requestAuthorization { speech = $0; asked.signal() }; asked.wait() }
guard speech == .authorized else { fail("speech-denied", "Allow Throughline Speech in System Settings › Privacy & Security › Speech Recognition.") }
guard recognizer.supportsOnDeviceRecognition else { fail("on-device", "On-device recognition isn't installed for \(recognizer.locale.identifier). Turn on Dictation for this language in System Settings › Keyboard, then try again.") }
guard recognizer.isAvailable else { fail("unavailable", "Speech recognition is unavailable right now. Try again in a moment.") }

// MARK: Recognition

var latest = ""
var finished = false
func finish(_ text: String) { if finished { return }; finished = true; emit(["type": "final", "text": text]); exit(0) }
func handle(_ result: SFSpeechRecognitionResult?, _ error: Error?) {
  if let result {
    latest = result.bestTranscription.formattedString
    if result.isFinal { finish(latest) } else { emit(["type": "partial", "text": latest]) }
  } else if let error {
    // No speech at all ends with an error; what was heard so far is still the answer.
    let code = (error as NSError).code
    if !latest.isEmpty || code == 1110 || code == 203 { finish(latest) }
    fail("recognition", error.localizedDescription)
  }
}

if let file = option("--file") {
  let request = SFSpeechURLRecognitionRequest(url: URL(fileURLWithPath: file))
  request.requiresOnDeviceRecognition = true
  request.shouldReportPartialResults = false
  if #available(macOS 13, *) { request.addsPunctuation = true }
  _ = recognizer.recognitionTask(with: request) { handle($0, $1) }
  dispatchMain()
}

var microphone = AVCaptureDevice.authorizationStatus(for: .audio)
if microphone == .notDetermined { AVCaptureDevice.requestAccess(for: .audio) { microphone = $0 ? .authorized : .denied; asked.signal() }; asked.wait() }
guard microphone == .authorized else { fail("microphone-denied", "Allow Throughline Speech in System Settings › Privacy & Security › Microphone.") }

let engine = AVAudioEngine()
let input = engine.inputNode
let format = input.outputFormat(forBus: 0)
guard format.sampleRate > 0, format.channelCount > 0 else { fail("no-microphone", "No microphone is available.") }
let request = SFSpeechAudioBufferRecognitionRequest()
request.requiresOnDeviceRecognition = true
request.shouldReportPartialResults = true
if #available(macOS 13, *) { request.addsPunctuation = true }
var lastLevel = Date.distantPast
input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
  request.append(buffer)
  guard Date().timeIntervalSince(lastLevel) > 0.08, let samples = buffer.floatChannelData?[0] else { return }
  lastLevel = Date()
  var sum: Float = 0
  for index in 0..<Int(buffer.frameLength) { sum += samples[index] * samples[index] }
  let rms = (sum / Float(max(buffer.frameLength, 1))).squareRoot()
  emit(["type": "level", "value": Double(max(0, min(1, (20 * log10(max(rms, 0.000_01)) + 50) / 50)))])
}
let task = recognizer.recognitionTask(with: request) { handle($0, $1) }
do { engine.prepare(); try engine.start() } catch { fail("no-microphone", "The microphone could not start: \(error.localizedDescription)") }
emit(["type": "ready"])

// Stopping ends the audio; the recognizer then delivers its final transcript. If it does not within a few seconds,
// what was heard so far is the answer.
func stop() {
  engine.stop(); input.removeTap(onBus: 0); request.endAudio()
  DispatchQueue.main.asyncAfter(deadline: .now() + 4) { task.cancel(); finish(latest) }
}
DispatchQueue.global().async {
  while let line = readLine() { if line.trimmingCharacters(in: .whitespaces) == "stop" { break } }
  DispatchQueue.main.async { stop() }
}
dispatchMain()
