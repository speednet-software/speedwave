#ifndef WHISPER_DIARIZATION_H
#define WHISPER_DIARIZATION_H

#include "ggml.h"

#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>

#define WHISPER_API

#ifdef __cplusplus
extern "C" {
#endif

    //
    // Experimental diarization.
    //
    struct whisper_diar_context;
    struct whisper_diar_segments;

    struct whisper_diar_context_params {
        int  n_threads;
        bool use_gpu;
        int  gpu_device;
        bool flash_attn;
    };

    struct whisper_diar_params {
        // the following two fields together specify a "in speech" zone. If the
        // probability for a speaker in a 10ms frame is greater than or equal to
        // start it will be considered an active segment. And it will continue to
        // be considered active until the probability drops below the stop threshold.
        // Using different value enables hysteresis (to have a non-abrupt cutoff).
        float start_threshold;
        float stop_threshold;

        // padding added to the start and end of each detected segment (ms) before
        // merging and duration filtering. Expanding segments encourages nearby
        // fragments to be joined by the min_silence_duration_ms merge pass.
        int start_pad_ms;
        int end_pad_ms;

        // min duration of active segments (after padding). Segments shorter than
        // this value are dropped.
        int min_speech_duration_ms;

        // gap in ms between two segments (after padding). If the time between two
        // segments is less than this value they are merged into one.
        int min_silence_duration_ms;
    };

    WHISPER_API struct whisper_diar_context_params whisper_diar_default_context_params(void);

    WHISPER_API struct whisper_diar_context * whisper_diar_init_from_file_with_params(
            const char * path_model, struct whisper_diar_context_params params);

    WHISPER_API bool whisper_diar_detect_speakers(struct whisper_diar_context * ctx,
            const float * samples, int64_t n_samples);

    WHISPER_API int     whisper_diar_n_speakers(const struct whisper_diar_context * ctx);
    WHISPER_API int64_t whisper_diar_n_frames  (const struct whisper_diar_context * ctx);

    WHISPER_API const float * whisper_diar_probs(const struct whisper_diar_context * ctx);

    WHISPER_API int whisper_diar_speaker_for_time(const struct whisper_diar_context * ctx,
            int64_t t0, int64_t t1, float threshold);

    WHISPER_API struct whisper_diar_params whisper_diar_default_params(void);

    WHISPER_API struct whisper_diar_segments * whisper_diar_segments_from_probs(
            const struct whisper_diar_context * ctx, struct whisper_diar_params params);

    WHISPER_API int whisper_diar_segments_n_segments(const struct whisper_diar_segments * segments);

    WHISPER_API int64_t whisper_diar_segments_get_segment_t0(const struct whisper_diar_segments * segments, int i);
    WHISPER_API int64_t whisper_diar_segments_get_segment_t1(const struct whisper_diar_segments * segments, int i);
    WHISPER_API int whisper_diar_segments_get_speaker(const struct whisper_diar_segments * segments, int i);

    WHISPER_API void whisper_diar_free_segments(struct whisper_diar_segments * segments);

    WHISPER_API void whisper_diar_free(struct whisper_diar_context * ctx);

    void speedwave_diar_log_set(ggml_log_callback callback, void * user_data);

    void speedwave_diar_abi_sizes(size_t * context_params, size_t * params);

#ifdef __cplusplus
}
#endif

#endif
