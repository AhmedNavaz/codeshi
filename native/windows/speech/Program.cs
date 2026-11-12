// Codeshi Speech for Windows: speech recognition on this computer for voice input (#73).
//
// It speaks the same protocol as the Mac helper (native/macos/speech/main.swift). It listens to the microphone, or
// reads a WAV file with --file, and writes one JSON object per line to stdout:
//   {"type":"ready"}                      listening has started
//   {"type":"level","value":0.4}          microphone level, 0 to 1, a few times a second
//   {"type":"partial","text":"…"}         the transcript so far
//   {"type":"final","text":"…"}           the finished transcript, then the helper exits
//   {"type":"error","code":"…","message":"…"}
// --check reports what Windows allows and whether a recognizer is installed, without opening the microphone. Listening
// stops when stdin receives "stop" or closes.
//
// Recognition uses the offline engine in .NET's System.Speech, which ships with Windows: audio never leaves the
// computer and nothing needs installing. It is built with the C# compiler that is part of Windows (csc.exe from .NET
// Framework 4), so this file keeps to C# 5.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Speech.Recognition;
using System.Text;
using System.Threading;
using Microsoft.Win32;

static class Program {
  static readonly object Gate = new object();
  static readonly Stream Out = Console.OpenStandardOutput();
  static readonly List<string> Heard = new List<string>();
  static readonly ManualResetEvent Done = new ManualResetEvent(false);
  static bool finished;
  static DateTime lastLevel = DateTime.MinValue;

  static string Quote(string text) {
    var json = new StringBuilder("\"");
    foreach (var c in text ?? "") {
      if (c == '"') json.Append("\\\""); else if (c == '\\') json.Append("\\\\");
      else if (c == '\n') json.Append("\\n"); else if (c == '\r') json.Append("\\r"); else if (c == '\t') json.Append("\\t");
      else if (c < ' ') json.Append("\\u").Append(((int)c).ToString("x4")); else json.Append(c);
    }
    return json.Append('"').ToString();
  }
  static void Emit(string json) {
    var bytes = new UTF8Encoding(false).GetBytes(json + "\n");
    lock (Gate) { try { Out.Write(bytes, 0, bytes.Length); Out.Flush(); } catch (IOException) { /* Nobody is reading any more. */ } }
  }
  static void Fail(string code, string message) {
    Emit("{\"type\":\"error\",\"code\":" + Quote(code) + ",\"message\":" + Quote(message) + "}");
    Environment.Exit(2);
  }
  static void Finish() {
    // A second caller waits for the first to write the transcript and exit.
    bool first; lock (Heard) { first = !finished; finished = true; }
    if (!first) Thread.Sleep(Timeout.Infinite);
    Emit("{\"type\":\"final\",\"text\":" + Quote(Transcript(null)) + "}");
    Environment.Exit(0);
  }
  static string Option(string[] args, string name) {
    var index = Array.IndexOf(args, name);
    return index >= 0 && index + 1 < args.Length ? args[index + 1] : null;
  }
  // What was recognized so far, with the phrase still being heard at the end.
  static string Transcript(string hypothesis) {
    lock (Heard) {
      var parts = new List<string>(Heard);
      if (!String.IsNullOrWhiteSpace(hypothesis)) parts.Add(hypothesis.Trim());
      return String.Join(" ", parts);
    }
  }

  // Settings > Privacy & security > Microphone: the switch for everything, and the one for desktop apps.
  static string Microphone() {
    const string store = @"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone";
    foreach (var hive in new[] { Registry.LocalMachine, Registry.CurrentUser })
      foreach (var key in new[] { store, store + @"\NonPackaged" }) {
        try { using (var opened = hive.OpenSubKey(key)) { if (opened != null && String.Equals(opened.GetValue("Value") as string, "Deny", StringComparison.OrdinalIgnoreCase)) return "denied"; } }
        catch (Exception) { /* Unreadable means undecided. */ }
      }
    return "authorized";
  }

  // The recognizer for the language asked for: that region's, or another region of the same language.
  static RecognizerInfo Recognizer(CultureInfo culture) {
    RecognizerInfo sameLanguage = null;
    foreach (var info in SpeechRecognitionEngine.InstalledRecognizers()) {
      if (String.Equals(info.Culture.Name, culture.Name, StringComparison.OrdinalIgnoreCase)) return info;
      if (sameLanguage == null && info.Culture.TwoLetterISOLanguageName == culture.TwoLetterISOLanguageName) sameLanguage = info;
    }
    return sameLanguage;
  }

  static int Main(string[] args) {
    var check = Array.IndexOf(args, "--check") >= 0;
    var asked = Option(args, "--locale");
    CultureInfo culture = null;
    try { culture = asked == null ? CultureInfo.CurrentUICulture : CultureInfo.GetCultureInfo(asked.Replace('_', '-')); } catch (Exception) { /* Reported below. */ }
    RecognizerInfo recognizer = null;
    try { if (culture != null) recognizer = Recognizer(culture); }
    catch (Exception error) { if (!check) Fail("unavailable", "Windows speech recognition is unavailable: " + error.Message); }
    // With no language named, any installed recognizer is better than none.
    if (recognizer == null && asked == null) { try { var all = SpeechRecognitionEngine.InstalledRecognizers(); if (all.Count > 0) recognizer = all[0]; } catch (Exception) { /* Reported below. */ } }

    var name = culture != null ? culture.Name : asked;
    if (check) {
      if (recognizer == null && asked != null && culture == null) Fail("language", "Speech recognition isn't available for " + asked + ".");
      Emit("{\"type\":\"check\",\"speech\":\"authorized\",\"microphone\":\"" + Microphone() + "\",\"onDevice\":" + (recognizer != null ? "true" : "false") + ",\"available\":" + (recognizer != null ? "true" : "false") + ",\"locale\":" + Quote(recognizer != null ? recognizer.Culture.Name : name) + "}");
      return 0;
    }
    if (recognizer == null) Fail("language", "Windows has no speech recognition installed for " + name + ". Add it in Settings > Time & language > Language & region: choose the language, then Language options > Speech.");

    var file = Option(args, "--file");
    if (file == null && Microphone() == "denied") Fail("microphone-denied", "Allow microphone access in Settings > Privacy & security > Microphone, including for desktop apps.");

    SpeechRecognitionEngine engine = null;
    try {
      engine = new SpeechRecognitionEngine(recognizer);
      engine.LoadGrammar(new DictationGrammar());
    } catch (Exception error) { Fail("unavailable", "Windows speech recognition could not start: " + error.Message); }
    try { if (file != null) engine.SetInputToWaveFile(file); else engine.SetInputToDefaultAudioDevice(); }
    catch (Exception error) { Fail("no-microphone", file != null ? "The audio file could not be read: " + error.Message : "No microphone is available."); }

    // Dictation should wait through a pause for thought rather than end the phrase early.
    engine.EndSilenceTimeout = TimeSpan.FromMilliseconds(700);
    engine.EndSilenceTimeoutAmbiguous = TimeSpan.FromMilliseconds(1000);
    engine.SpeechHypothesized += (sender, e) => { if (file == null) Emit("{\"type\":\"partial\",\"text\":" + Quote(Transcript(e.Result.Text)) + "}"); };
    engine.SpeechRecognized += (sender, e) => {
      if (e.Result == null || String.IsNullOrWhiteSpace(e.Result.Text)) return;
      lock (Heard) Heard.Add(e.Result.Text.Trim());
      if (file == null) Emit("{\"type\":\"partial\",\"text\":" + Quote(Transcript(null)) + "}");
    };
    engine.AudioLevelUpdated += (sender, e) => {
      if (file != null || (DateTime.UtcNow - lastLevel).TotalMilliseconds < 80) return;
      lastLevel = DateTime.UtcNow;
      Emit("{\"type\":\"level\",\"value\":" + Math.Max(0, Math.Min(1, e.AudioLevel / 100.0)).ToString("0.###", CultureInfo.InvariantCulture) + "}");
    };
    // The end of a file, a stop that has been carried out, or a microphone that went away.
    engine.RecognizeCompleted += (sender, e) => Done.Set();

    try { engine.RecognizeAsync(RecognizeMode.Multiple); }
    catch (Exception error) { Fail("no-microphone", "The microphone could not start: " + error.Message); }
    if (file == null) Emit("{\"type\":\"ready\"}");

    // Stopping lets the recognizer finish the phrase it is in. If it does not within a few seconds, what was heard so
    // far is the answer.
    var input = new Thread(() => {
      try { string line; while ((line = Console.In.ReadLine()) != null) { if (line.Trim() == "stop") break; } } catch (Exception) { /* A closed stdin stops too. */ }
      try { engine.RecognizeAsyncStop(); } catch (Exception) { /* Already stopped. */ }
      Done.WaitOne(4000);
      Finish();
    });
    input.IsBackground = true;
    if (file == null) input.Start();

    Done.WaitOne();
    // A stop is finished by the thread above, once the last phrase has arrived.
    if (file == null) Thread.Sleep(200);
    Finish();
    return 0;
  }
}
