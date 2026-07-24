#include <Carbon/Carbon.h>
#include <CoreFoundation/CoreFoundation.h>
#include <stdio.h>
#include <string.h>

static int select_input_source(CFStringRef wanted_id) {
  CFArrayRef sources = TISCreateInputSourceList(NULL, false);
  if (sources == NULL) return 2;

  int result = 3;
  CFIndex count = CFArrayGetCount(sources);
  for (CFIndex index = 0; index < count; index += 1) {
    TISInputSourceRef source = (TISInputSourceRef)CFArrayGetValueAtIndex(sources, index);
    CFStringRef source_id = (CFStringRef)TISGetInputSourceProperty(source, kTISPropertyInputSourceID);
    if (source_id == NULL || !CFEqual(source_id, wanted_id)) continue;

    TISEnableInputSource(source);
    result = TISSelectInputSource(source) == noErr ? 0 : 4;
    break;
  }

  CFRelease(sources);
  return result;
}

static int print_current_input_source(void) {
  TISInputSourceRef source = TISCopyCurrentKeyboardInputSource();
  if (source == NULL) return 2;

  CFStringRef source_id = (CFStringRef)TISGetInputSourceProperty(source, kTISPropertyInputSourceID);
  char buffer[512];
  int result = 3;
  if (source_id != NULL &&
      CFStringGetCString(source_id, buffer, sizeof(buffer), kCFStringEncodingUTF8)) {
    puts(buffer);
    result = 0;
  }

  CFRelease(source);
  return result;
}

int main(int argc, char *argv[]) {
  if (argc == 2 && strcmp(argv[1], "--current") == 0) {
    return print_current_input_source();
  }

  int result = select_input_source(CFSTR("com.apple.keylayout.ABC"));
  if (result == 0) return 0;

  /* Older macOS installations may expose the equivalent layout as U.S. */
  return select_input_source(CFSTR("com.apple.keylayout.US"));
}
