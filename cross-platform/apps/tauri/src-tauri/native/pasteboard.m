// Reads the general pasteboard for the AI inbox: copied Finder files, HTML
// and plain text. Strings are returned malloc'd; free with notebook_free_string.
#import <AppKit/AppKit.h>
#include <stdlib.h>
#include <string.h>

static char *copy_utf8(NSString *value) {
    if (value == nil) return NULL;
    const char *utf8 = [value UTF8String];
    return utf8 ? strdup(utf8) : NULL;
}

char *notebook_pasteboard_file_paths(void) {
    @autoreleasepool {
        NSPasteboard *board = [NSPasteboard generalPasteboard];
        NSArray *urls = [board readObjectsForClasses:@[[NSURL class]] options:@{NSPasteboardURLReadingFileURLsOnlyKey: @YES}];
        NSMutableArray *paths = [NSMutableArray array];
        for (NSURL *url in urls) {
            if ([url isFileURL] && [url path] != nil) [paths addObject:[url path]];
        }
        if ([paths count] == 0) return NULL;
        return copy_utf8([paths componentsJoinedByString:@"\n"]);
    }
}

char *notebook_pasteboard_string(const char *type) {
    @autoreleasepool {
        NSString *name = [NSString stringWithUTF8String:type];
        return copy_utf8([[NSPasteboard generalPasteboard] stringForType:name]);
    }
}

long notebook_pasteboard_change_count(void) {
    @autoreleasepool {
        return (long)[[NSPasteboard generalPasteboard] changeCount];
    }
}

void notebook_free_string(char *value) {
    free(value);
}
