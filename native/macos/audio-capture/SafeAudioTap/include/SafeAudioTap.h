#import <AVFoundation/AVFoundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Error domain of an Objective-C exception `SPWSafeTap` caught.
extern NSErrorDomain const SPWSafeTapErrorDomain;

/// Installs an audio tap from Objective-C, so an exception AVFoundation raises never reaches Swift.
@interface SPWSafeTap : NSObject

/// Installs `tapBlock` on `bus` of `node`; returns NO and sets `error` to the exception's name and reason when AVFoundation raised one.
+ (BOOL)installOnNode:(AVAudioNode *)node
                  bus:(AVAudioNodeBus)bus
           bufferSize:(AVAudioFrameCount)bufferSize
               format:(nullable AVAudioFormat *)format
                block:(AVAudioNodeTapBlock)tapBlock
                error:(NSError *_Nullable *_Nullable)error
    NS_SWIFT_NAME(install(on:bus:bufferSize:format:block:));

@end

NS_ASSUME_NONNULL_END
