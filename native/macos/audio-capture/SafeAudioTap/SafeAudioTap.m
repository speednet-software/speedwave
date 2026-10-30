#import "SafeAudioTap.h"

NSErrorDomain const SPWSafeTapErrorDomain = @"pl.speedwave.audio-capture.tap";

@implementation SPWSafeTap

+ (BOOL)installOnNode:(AVAudioNode *)node
                  bus:(AVAudioNodeBus)bus
           bufferSize:(AVAudioFrameCount)bufferSize
               format:(nullable AVAudioFormat *)format
                block:(AVAudioNodeTapBlock)tapBlock
                error:(NSError *_Nullable *_Nullable)error {
    @try {
        [node installTapOnBus:bus bufferSize:bufferSize format:format block:tapBlock];
        return YES;
    } @catch (NSException *exception) {
        if (error) {
            NSString *description = [NSString stringWithFormat:@"%@: %@", exception.name, exception.reason ?: @"no reason given"];
            *error = [NSError errorWithDomain:SPWSafeTapErrorDomain
                                         code:1
                                     userInfo:@{NSLocalizedDescriptionKey: description}];
        }
        return NO;
    }
}

@end
