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

    struct whisper_diar_context;
    struct whisper_diar_segments;

    struct whisper_diar_context_params {
        int  n_threads;
        bool use_gpu;
        int  gpu_device;
        bool flash_attn;
    };

    struct whisper_diar_params {
        float start_threshold;
        float stop_threshold;

        int start_pad_ms;
        int end_pad_ms;

        int min_speech_duration_ms;

        int min_silence_duration_ms;
    };

    WHISPER_API struct whisper_diar_context_params whisper_diar_default_context_params(void);

    WHISPER_API struct whisper_diar_context * whisper_diar_init_from_file_with_params(
            const char * path_model, struct whisper_diar_context_params params);

    WHISPER_API bool whisper_diar_detect_speakers(struct whisper_diar_context * ctx,
            const float * samples, int64_t n_samples,
            ggml_abort_callback abort_callback, void * abort_callback_data);

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
