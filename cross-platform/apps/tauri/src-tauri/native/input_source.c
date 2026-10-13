#include <Carbon/Carbon.h>
#include <CoreFoundation/CoreFoundation.h>

/* Selects a keyboard layout by its input-source id. 0 on success. */
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

/* Vim normal mode needs plain ASCII keys: switch to ABC (or U.S. on old systems). */
int notebook_select_abc_input_source(void) {
  int result = select_input_source(CFSTR("com.apple.keylayout.ABC"));
  if (result == 0) return 0;
  return select_input_source(CFSTR("com.apple.keylayout.US"));
}
