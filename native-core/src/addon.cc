#include <node_api.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <deque>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

// Optional CUDA bindings.
// - Default build: compiles without CUDA and reports cuda.available=false.
// - CUDA build: define KGM_ENABLE_CUDA and link against cudart.
#ifdef KGM_ENABLE_CUDA
#include <cuda_runtime.h>
#endif

namespace {

using Clock = std::chrono::steady_clock;

// ---------------- CUDA API (optional) ----------------
struct CudaAllocation {
  void* ptr = nullptr;
  size_t byte_length = 0;
};

static std::unordered_map<std::string, CudaAllocation> g_cuda_allocations;
static uint64_t g_cuda_next_id = 1;

static napi_value MakeString(napi_env env, const std::string& value) {
  napi_value out;
  napi_status status = napi_create_string_utf8(env, value.c_str(), value.size(), &out);
  if (status != napi_ok) {
    napi_throw_error(env, nullptr, "napi_create_string_failed");
  }
  return out;
}

static napi_value MakeBool(napi_env env, bool value) {
  napi_value out;
  napi_status status = napi_get_boolean(env, value, &out);
  if (status != napi_ok) {
    napi_throw_error(env, nullptr, "napi_get_boolean_failed");
  }
  return out;
}

static napi_value CudaDeviceInfo(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value obj;
  napi_create_object(env, &obj);
#ifdef KGM_ENABLE_CUDA
  int count = 0;
  cudaError_t err = cudaGetDeviceCount(&count);
  bool available = (err == cudaSuccess && count > 0);
  napi_set_named_property(env, obj, "available", MakeBool(env, available));
  napi_value dc;
  napi_create_int32(env, count, &dc);
  napi_set_named_property(env, obj, "deviceCount", dc);
  if (!available) {
    napi_set_named_property(env, obj, "reason", MakeString(env, cudaGetErrorString(err)));
  }
#else
  napi_set_named_property(env, obj, "available", MakeBool(env, false));
  napi_set_named_property(env, obj, "reason", MakeString(env, "cuda_not_enabled_in_build"));
#endif
  return obj;
}

static napi_value CudaMalloc(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc < 1) {
    napi_throw_error(env, nullptr, "cudaMalloc_requires_size");
    return nullptr;
  }
  int64_t byte_length = 0;
  napi_get_value_int64(env, argv[0], &byte_length);
  if (byte_length < 0) {
    byte_length = 0;
  }

#ifdef KGM_ENABLE_CUDA
  void* ptr = nullptr;
  cudaError_t err = cudaMalloc(&ptr, static_cast<size_t>(byte_length));
  if (err != cudaSuccess) {
    napi_throw_error(env, nullptr, cudaGetErrorString(err));
    return nullptr;
  }
  std::string id = "cuda_" + std::to_string(g_cuda_next_id++);
  g_cuda_allocations[id] = {ptr, static_cast<size_t>(byte_length)};

  napi_value out;
  napi_create_object(env, &out);
  napi_set_named_property(env, out, "id", MakeString(env, id));
  return out;
#else
  napi_throw_error(env, nullptr, "cuda_not_enabled_in_build");
  return nullptr;
#endif
}

static napi_value CudaMemcpyHtoD(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc < 2) {
    napi_throw_error(env, nullptr, "cudaMemcpyHtoD_requires_ptr_and_bytes");
    return nullptr;
  }

  napi_value idValue;
  napi_get_named_property(env, argv[0], "id", &idValue);
  size_t idLen = 0;
  napi_get_value_string_utf8(env, idValue, nullptr, 0, &idLen);
  std::string id;
  id.resize(idLen);
  napi_get_value_string_utf8(env, idValue, id.data(), idLen + 1, &idLen);

#ifdef KGM_ENABLE_CUDA
  auto found = g_cuda_allocations.find(id);
  if (found == g_cuda_allocations.end() || !found->second.ptr) {
    napi_throw_error(env, nullptr, "cuda_invalid_ptr");
    return nullptr;
  }

  void* data = nullptr;
  size_t byte_length = 0;
  napi_typedarray_type type;
  napi_value arraybuffer;
  size_t offset;
  napi_get_typedarray_info(env, argv[1], &type, &byte_length, &data, &arraybuffer, &offset);
  if (!data) {
    napi_throw_error(env, nullptr, "cudaMemcpyHtoD_requires_typedarray");
    return nullptr;
  }
  if (byte_length != found->second.byte_length) {
    napi_throw_error(env, nullptr, "cudaMemcpy_size_mismatch");
    return nullptr;
  }
  cudaError_t err = cudaMemcpy(found->second.ptr, data, byte_length, cudaMemcpyHostToDevice);
  if (err != cudaSuccess) {
    napi_throw_error(env, nullptr, cudaGetErrorString(err));
    return nullptr;
  }
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
#else
  napi_throw_error(env, nullptr, "cuda_not_enabled_in_build");
  return nullptr;
#endif
}

static napi_value CudaMemcpyDtoH(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc < 1) {
    napi_throw_error(env, nullptr, "cudaMemcpyDtoH_requires_ptr");
    return nullptr;
  }

  napi_value idValue;
  napi_get_named_property(env, argv[0], "id", &idValue);
  size_t idLen = 0;
  napi_get_value_string_utf8(env, idValue, nullptr, 0, &idLen);
  std::string id;
  id.resize(idLen);
  napi_get_value_string_utf8(env, idValue, id.data(), idLen + 1, &idLen);

#ifdef KGM_ENABLE_CUDA
  auto found = g_cuda_allocations.find(id);
  if (found == g_cuda_allocations.end() || !found->second.ptr) {
    napi_throw_error(env, nullptr, "cuda_invalid_ptr");
    return nullptr;
  }
  void* device_ptr = found->second.ptr;
  size_t byte_length = found->second.byte_length;

  void* data = nullptr;
  napi_value arraybuffer;
  ThrowIfFailed(env, napi_create_arraybuffer(env, byte_length, &data, &arraybuffer), "napi_create_arraybuffer_failed");
  cudaError_t err = cudaMemcpy(data, device_ptr, byte_length, cudaMemcpyDeviceToHost);
  if (err != cudaSuccess) {
    napi_throw_error(env, nullptr, cudaGetErrorString(err));
    return nullptr;
  }
  napi_value out;
  ThrowIfFailed(env, napi_create_typedarray(env, napi_uint8_array, byte_length, arraybuffer, 0, &out), "napi_create_typedarray_failed");
  return out;
#else
  napi_throw_error(env, nullptr, "cuda_not_enabled_in_build");
  return nullptr;
#endif
}

static napi_value CudaFree(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc < 1) {
    napi_throw_error(env, nullptr, "cudaFree_requires_ptr");
    return nullptr;
  }
  napi_value idValue;
  napi_get_named_property(env, argv[0], "id", &idValue);
  size_t idLen = 0;
  napi_get_value_string_utf8(env, idValue, nullptr, 0, &idLen);
  std::string id;
  id.resize(idLen);
  napi_get_value_string_utf8(env, idValue, id.data(), idLen + 1, &idLen);

#ifdef KGM_ENABLE_CUDA
  auto found = g_cuda_allocations.find(id);
  if (found != g_cuda_allocations.end() && found->second.ptr) {
    cudaFree(found->second.ptr);
    found->second.ptr = nullptr;
    found->second.byte_length = 0;
    g_cuda_allocations.erase(found);
  }
#endif
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

enum class TensorDType {
  F32,
  Q8_0,
};

struct Tensor {
  TensorDType dtype = TensorDType::F32;
  std::vector<int64_t> shape;
  std::vector<float> data_f32;
  std::vector<int8_t> data_q8;
  std::vector<float> scales;
  int64_t block_size = 0;
};

struct LayerWeights {
  std::vector<float> attn_norm;
  std::vector<float> ffn_norm;
  Tensor wq;
  Tensor wk;
  Tensor wv;
  Tensor wo;
  Tensor w1;
  Tensor w2;
  Tensor w3;
};

struct ModelConfig {
  int64_t vocab_size = 0;
  int64_t hidden_size = 0;
  int64_t intermediate_size = 0;
  int64_t num_layers = 0;
  int64_t num_heads = 0;
  int64_t num_kv_heads = 0;
  int64_t max_position_embeddings = 0;
  double rope_theta = 10000.0;
  int64_t rope_dimension = 0;
  double norm_eps = 1e-5;
  int64_t bos_token_id = -1;
  int64_t eos_token_id = -1;
  int64_t pad_token_id = -1;
};

struct Model {
  ModelConfig config;
  Tensor token_embedding;
  std::vector<float> output_norm;
  Tensor lm_head;
  std::vector<LayerWeights> layers;
  int64_t head_dim = 0;
};

struct SchedulerOptions {
  int64_t max_batch_size = 8;
  int64_t max_prefills_per_tick = 1;
  uint32_t seed = 1;
  int64_t cached_kv_page_budget = 0;
};

struct RequestOptions {
  std::string model;
  std::string request_id;
  std::string session_id;
  std::vector<int64_t> prompt_tokens;
  int64_t max_tokens = 64;
  double temperature = 0.2;
  int64_t top_k = 0;
  double top_p = 1.0;
  double repetition_penalty = 1.0;
  std::vector<std::string> stop;
};

struct SchedulerStats {
  int64_t submitted = 0;
  int64_t completed = 0;
  int64_t failed = 0;
  int64_t cancelled = 0;
  int64_t cycles = 0;
  int64_t prefills = 0;
  int64_t decode_steps = 0;
  int64_t peak_active = 0;
  int64_t peak_queued = 0;
};

struct FinishedPayload {
  std::string text;
  int64_t prompt_tokens = 0;
  int64_t prefill_tokens = 0;
  int64_t generated_tokens = 0;
  std::string finish_reason = "length";
  double ttft_ms = 0;
  double tpot_ms = 0;
  double tokens_per_second = 0;
  std::string request_id;
  std::string session_id;
  double queue_wait_ms = 0;
  int64_t request_scheduler_cycles = 0;
  int64_t engine_scheduler_cycles = 0;
  int64_t peak_active_requests = 0;
  int64_t peak_queued_requests = 0;
  int64_t active_requests_at_admission = 0;
  int64_t queued_requests_at_admission = 0;
  int64_t kv_resident_bytes = 0;
  int64_t kv_allocated_pages = 0;
  int64_t cached_kv_resident_pages = 0;
  int64_t cached_kv_page_budget = 0;
};

struct NativeEvent {
  enum class Type {
    Started,
    Token,
    Finished,
  };

  Type type = Type::Started;
  std::string model;
  std::string text;
  int64_t index = 0;
  int64_t token_id = -1;
  FinishedPayload finished;
};

class CharacterTokenizer {
 public:
  CharacterTokenizer(
    std::vector<std::string> vocab,
    int64_t bos_token_id,
    int64_t eos_token_id,
    int64_t unk_token_id,
    int64_t pad_token_id)
    : vocab_(std::move(vocab)),
      bos_token_id_(bos_token_id),
      eos_token_id_(eos_token_id),
      unk_token_id_(unk_token_id),
      pad_token_id_(pad_token_id) {
    for (size_t index = 0; index < vocab_.size(); ++index) {
      piece_to_id_[vocab_[index]] = static_cast<int64_t>(index);
      id_to_piece_[static_cast<int64_t>(index)] = vocab_[index];
      if (!vocab_[index].empty() && vocab_[index][0] != '<') {
        candidate_pieces_.push_back(vocab_[index]);
      }
    }
    std::sort(candidate_pieces_.begin(), candidate_pieces_.end(), [](const std::string& left, const std::string& right) {
      return left.size() > right.size();
    });
  }

  std::vector<int64_t> Encode(const std::string& text, bool add_bos) const {
    std::vector<int64_t> tokens;
    if (add_bos && bos_token_id_ >= 0) {
      tokens.push_back(bos_token_id_);
    }
    size_t cursor = 0;
    while (cursor < text.size()) {
      bool matched = false;
      for (const auto& piece : candidate_pieces_) {
        if (piece.empty()) {
          continue;
        }
        if (text.compare(cursor, piece.size(), piece) == 0) {
          auto found = piece_to_id_.find(piece);
          if (found != piece_to_id_.end()) {
            tokens.push_back(found->second);
            cursor += piece.size();
            matched = true;
            break;
          }
        }
      }
      if (matched) {
        continue;
      }
      std::string single(1, text[cursor]);
      auto found = piece_to_id_.find(single);
      if (found != piece_to_id_.end()) {
        tokens.push_back(found->second);
      } else if (unk_token_id_ >= 0) {
        tokens.push_back(unk_token_id_);
      }
      cursor += 1;
    }
    return tokens;
  }

  std::string Decode(const std::vector<int64_t>& tokens, bool skip_special_tokens) const {
    std::string output;
    for (int64_t token : tokens) {
      if (skip_special_tokens && IsSpecialToken(token)) {
        continue;
      }
      auto found = id_to_piece_.find(token);
      if (found != id_to_piece_.end()) {
        output += found->second;
      }
    }
    return output;
  }

  int64_t eos_token_id() const {
    return eos_token_id_;
  }

  int64_t bos_token_id() const {
    return bos_token_id_;
  }

 private:
  bool IsSpecialToken(int64_t token) const {
    if (token == bos_token_id_ || token == eos_token_id_ || token == pad_token_id_ || token == unk_token_id_) {
      return true;
    }
    auto found = id_to_piece_.find(token);
    return found != id_to_piece_.end() && !found->second.empty() && found->second[0] == '<';
  }

  std::vector<std::string> vocab_;
  std::unordered_map<std::string, int64_t> piece_to_id_;
  std::unordered_map<int64_t, std::string> id_to_piece_;
  std::vector<std::string> candidate_pieces_;
  int64_t bos_token_id_ = -1;
  int64_t eos_token_id_ = -1;
  int64_t unk_token_id_ = -1;
  int64_t pad_token_id_ = -1;
};

class DenseKvCache {
 public:
  DenseKvCache(int64_t max_positions, int64_t num_layers, int64_t num_kv_heads, int64_t head_dim)
      : max_positions_(max_positions),
        num_layers_(num_layers),
        num_kv_heads_(num_kv_heads),
        head_dim_(head_dim),
        position_(0) {
    keys_.resize(num_layers_);
    values_.resize(num_layers_);
    const size_t layer_size = static_cast<size_t>(max_positions_ * num_kv_heads_ * head_dim_);
    for (int64_t index = 0; index < num_layers_; ++index) {
      keys_[index].assign(layer_size, 0.0f);
      values_[index].assign(layer_size, 0.0f);
    }
  }

  int64_t position() const {
    return position_;
  }

  void advance() {
    position_ += 1;
  }

  int64_t max_positions() const {
    return max_positions_;
  }

  void SetKey(int64_t layer, int64_t position, int64_t kv_head, const std::vector<float>& value) {
    size_t offset = Offset(position, kv_head);
    std::copy(value.begin(), value.end(), keys_[layer].begin() + static_cast<long>(offset));
  }

  void SetValue(int64_t layer, int64_t position, int64_t kv_head, const std::vector<float>& value) {
    size_t offset = Offset(position, kv_head);
    std::copy(value.begin(), value.end(), values_[layer].begin() + static_cast<long>(offset));
  }

  std::vector<float> GetKey(int64_t layer, int64_t position, int64_t kv_head) const {
    return Slice(keys_[layer], Offset(position, kv_head), static_cast<size_t>(head_dim_));
  }

  std::vector<float> GetValue(int64_t layer, int64_t position, int64_t kv_head) const {
    return Slice(values_[layer], Offset(position, kv_head), static_cast<size_t>(head_dim_));
  }

  int64_t resident_bytes() const {
    return static_cast<int64_t>(sizeof(float) * 2 * max_positions_ * num_layers_ * num_kv_heads_ * head_dim_);
  }

  int64_t allocated_pages() const {
    return num_layers_ * max_positions_;
  }

 private:
  size_t Offset(int64_t position, int64_t kv_head) const {
    return static_cast<size_t>((position * num_kv_heads_ + kv_head) * head_dim_);
  }

  static std::vector<float> Slice(const std::vector<float>& source, size_t offset, size_t length) {
    return std::vector<float>(source.begin() + static_cast<long>(offset), source.begin() + static_cast<long>(offset + length));
  }

  int64_t max_positions_ = 0;
  int64_t num_layers_ = 0;
  int64_t num_kv_heads_ = 0;
  int64_t head_dim_ = 0;
  int64_t position_ = 0;
  std::vector<std::vector<float>> keys_;
  std::vector<std::vector<float>> values_;
};

struct RequestState {
  int64_t internal_id = 0;
  std::string prompt;
  RequestOptions options;
  bool prepared = false;
  bool completed = false;
  bool cancelled = false;
  Clock::time_point enqueued_at = Clock::now();
  Clock::time_point started_at = Clock::now();
  double queue_wait_ms = 0;
  int64_t active_requests_at_admission = 0;
  int64_t queued_requests_at_admission = 0;
  std::vector<int64_t> prompt_tokens;
  std::unique_ptr<DenseKvCache> cache;
  std::vector<float> logits;
  std::vector<int64_t> generated;
  std::string output;
  double ttft_ms = 0;
  int64_t prefill_tokens = 0;
  int64_t scheduler_cycles = 0;
  std::string finish_reason = "length";
  std::deque<NativeEvent> events;
};

class NativeCoreBackendEngine {
 public:
  NativeCoreBackendEngine(Model model, std::optional<CharacterTokenizer> tokenizer, SchedulerOptions options)
      : model_(std::move(model)),
        tokenizer_(std::move(tokenizer)),
        options_(options),
        next_internal_id_(1),
        active_cursor_(0),
        random_state_(options.seed == 0 ? 1 : options.seed) {}

  bool is_executable() const {
    return true;
  }

  int64_t Submit(const std::string& prompt, const RequestOptions& options) {
    auto request = std::make_unique<RequestState>();
    request->internal_id = next_internal_id_++;
    request->prompt = prompt;
    request->options = options;
    request->enqueued_at = Clock::now();
    pending_.push_back(request->internal_id);
    requests_[request->internal_id] = std::move(request);
    stats_.submitted += 1;
    stats_.peak_queued = std::max<int64_t>(stats_.peak_queued, static_cast<int64_t>(pending_.size()));
    return next_internal_id_ - 1;
  }

  void Cancel(int64_t internal_id) {
    auto found = requests_.find(internal_id);
    if (found == requests_.end()) {
      return;
    }
    found->second->cancelled = true;
  }

  std::vector<NativeEvent> Poll(int64_t internal_id, int64_t max_events) {
    std::vector<NativeEvent> output;
    auto found = requests_.find(internal_id);
    if (found == requests_.end()) {
      return output;
    }
    RequestState* request = found->second.get();
    int steps = 0;
    while (request->events.empty() && !request->completed && steps < 64) {
      RunSchedulerCycle();
      steps += 1;
    }
    while (!request->events.empty() && static_cast<int64_t>(output.size()) < std::max<int64_t>(1, max_events)) {
      output.push_back(request->events.front());
      request->events.pop_front();
    }
    if (request->completed && request->events.empty()) {
      RemoveRequest(internal_id);
    }
    return output;
  }

  SchedulerStats scheduler_stats() const {
    return stats_;
  }

 private:
  void RunSchedulerCycle() {
    FlushCancelledPending();
    AdmitPending();
    FlushCancelledActive();
    if (active_order_.empty()) {
      return;
    }
    stats_.cycles += 1;
    const std::vector<int64_t> batch = SelectDecodeBatch();
    for (int64_t internal_id : batch) {
      auto found = requests_.find(internal_id);
      if (found == requests_.end()) {
        continue;
      }
      RequestState* request = found->second.get();
      if (request->completed) {
        continue;
      }
      if (request->cancelled) {
        FinishCancelledRequest(request);
        continue;
      }
      DecodeSingleStep(request);
    }
  }

  void FlushCancelledPending() {
    std::deque<int64_t> remaining;
    while (!pending_.empty()) {
      int64_t internal_id = pending_.front();
      pending_.pop_front();
      auto found = requests_.find(internal_id);
      if (found == requests_.end()) {
        continue;
      }
      if (found->second->cancelled) {
        stats_.cancelled += 1;
        found->second->completed = true;
        requests_.erase(internal_id);
        continue;
      }
      remaining.push_back(internal_id);
    }
    pending_ = std::move(remaining);
  }

  void FlushCancelledActive() {
    for (int64_t internal_id : active_order_) {
      auto found = requests_.find(internal_id);
      if (found == requests_.end()) {
        continue;
      }
      if (found->second->cancelled && !found->second->completed) {
        FinishCancelledRequest(found->second.get());
      }
    }
  }

  void AdmitPending() {
    int64_t admitted = 0;
    while (!pending_.empty() && admitted < options_.max_prefills_per_tick) {
      int64_t internal_id = pending_.front();
      pending_.pop_front();
      auto found = requests_.find(internal_id);
      if (found == requests_.end()) {
        continue;
      }
      RequestState* request = found->second.get();
      active_order_.push_back(internal_id);
      stats_.peak_active = std::max<int64_t>(stats_.peak_active, static_cast<int64_t>(active_order_.size()));
      NativeEvent started_event;
      started_event.type = NativeEvent::Type::Started;
      started_event.model = request->options.model;
      request->events.push_back(started_event);
      PrepareRequest(request);
      stats_.prefills += 1;
      admitted += 1;
    }
  }

  void PrepareRequest(RequestState* request) {
    request->prepared = true;
    request->started_at = Clock::now();
    request->queue_wait_ms = DurationMs(request->enqueued_at, request->started_at);
    request->active_requests_at_admission = static_cast<int64_t>(active_order_.size() - 1);
    request->queued_requests_at_admission = static_cast<int64_t>(pending_.size());
    request->prompt_tokens = request->options.prompt_tokens;
    if (request->prompt_tokens.empty() && tokenizer_.has_value()) {
      request->prompt_tokens = tokenizer_->Encode(request->prompt, request->prompt.empty() || tokenizer_->bos_token_id() >= 0);
      if (request->prompt_tokens.empty() && tokenizer_->bos_token_id() >= 0) {
        request->prompt_tokens.push_back(tokenizer_->bos_token_id());
      }
    }
    if (request->prompt_tokens.empty()) {
      throw std::runtime_error("native_core_prompt_encoding_empty");
    }
    request->prefill_tokens = static_cast<int64_t>(request->prompt_tokens.size());
    request->cache = std::make_unique<DenseKvCache>(
      model_.config.max_position_embeddings,
      model_.config.num_layers,
      model_.config.num_kv_heads,
      model_.head_dim);
    for (int64_t token : request->prompt_tokens) {
      request->logits = ForwardToken(token, *request->cache);
    }
  }

  std::vector<int64_t> SelectDecodeBatch() {
    std::vector<int64_t> selected;
    if (active_order_.empty()) {
      return selected;
    }
    if (active_cursor_ >= static_cast<int64_t>(active_order_.size())) {
      active_cursor_ = 0;
    }
    int64_t limit = std::min<int64_t>(options_.max_batch_size, static_cast<int64_t>(active_order_.size()));
    int64_t scanned = 0;
    while (static_cast<int64_t>(selected.size()) < limit && scanned < static_cast<int64_t>(active_order_.size())) {
      if (active_cursor_ >= static_cast<int64_t>(active_order_.size())) {
        active_cursor_ = 0;
      }
      int64_t internal_id = active_order_[static_cast<size_t>(active_cursor_++)];
      scanned += 1;
      auto found = requests_.find(internal_id);
      if (found != requests_.end() && !found->second->completed) {
        selected.push_back(internal_id);
      }
    }
    return selected;
  }

  void DecodeSingleStep(RequestState* request) {
    request->scheduler_cycles += 1;
    int64_t sampled = SampleToken(request->logits, *request);
    if (request->generated.empty()) {
      request->ttft_ms = DurationMs(request->started_at, Clock::now());
    }
    if (model_.config.eos_token_id >= 0 && sampled == model_.config.eos_token_id) {
      request->finish_reason = "eos";
      FinishRequest(request);
      return;
    }
    request->generated.push_back(sampled);
    const std::string next_output = tokenizer_.has_value() ? tokenizer_->Decode(request->generated, true) : std::string();
    for (const std::string& stop : request->options.stop) {
      size_t found = next_output.find(stop);
      if (found != std::string::npos) {
        std::string truncated = next_output.substr(0, found);
        std::string delta = truncated.substr(request->output.size());
        request->output = truncated;
        if (!delta.empty()) {
          NativeEvent token_event;
          token_event.type = NativeEvent::Type::Token;
          token_event.text = delta;
          token_event.index = static_cast<int64_t>(request->generated.size() - 1);
          token_event.token_id = sampled;
          request->events.push_back(token_event);
        }
        request->finish_reason = "stop";
        FinishRequest(request);
        return;
      }
    }
    std::string delta = next_output.substr(request->output.size());
    request->output = next_output;
    if (!delta.empty()) {
      NativeEvent token_event;
      token_event.type = NativeEvent::Type::Token;
      token_event.text = delta;
      token_event.index = static_cast<int64_t>(request->generated.size() - 1);
      token_event.token_id = sampled;
      request->events.push_back(token_event);
    }
    stats_.decode_steps += 1;
    if (static_cast<int64_t>(request->generated.size()) >= request->options.max_tokens) {
      request->finish_reason = "length";
      FinishRequest(request);
      return;
    }
    request->logits = ForwardToken(sampled, *request->cache);
  }

  void FinishCancelledRequest(RequestState* request) {
    request->completed = true;
    stats_.cancelled += 1;
    RemoveActive(request->internal_id);
  }

  void FinishRequest(RequestState* request) {
    request->completed = true;
    stats_.completed += 1;
    NativeEvent finished_event;
    finished_event.type = NativeEvent::Type::Finished;
    finished_event.finished.text = request->output;
    finished_event.finished.prompt_tokens = static_cast<int64_t>(request->prompt_tokens.size());
    finished_event.finished.prefill_tokens = request->prefill_tokens;
    finished_event.finished.generated_tokens = static_cast<int64_t>(request->generated.size());
    finished_event.finished.finish_reason = request->finish_reason;
    finished_event.finished.ttft_ms = request->ttft_ms;
    const double elapsed = DurationMs(request->started_at, Clock::now());
    if (request->generated.size() > 1) {
      finished_event.finished.tpot_ms = std::max(0.0, elapsed - request->ttft_ms) / static_cast<double>(request->generated.size() - 1);
    } else {
      finished_event.finished.tpot_ms = elapsed;
    }
    finished_event.finished.tokens_per_second = request->generated.empty()
      ? 0.0
      : static_cast<double>(request->generated.size()) / std::max(elapsed / 1000.0, 0.001);
    finished_event.finished.request_id = request->options.request_id;
    finished_event.finished.session_id = request->options.session_id;
    finished_event.finished.queue_wait_ms = request->queue_wait_ms;
    finished_event.finished.request_scheduler_cycles = request->scheduler_cycles;
    finished_event.finished.engine_scheduler_cycles = stats_.cycles;
    finished_event.finished.peak_active_requests = stats_.peak_active;
    finished_event.finished.peak_queued_requests = stats_.peak_queued;
    finished_event.finished.active_requests_at_admission = request->active_requests_at_admission;
    finished_event.finished.queued_requests_at_admission = request->queued_requests_at_admission;
    finished_event.finished.kv_resident_bytes = request->cache ? request->cache->resident_bytes() : 0;
    finished_event.finished.kv_allocated_pages = request->cache ? request->cache->allocated_pages() : 0;
    finished_event.finished.cached_kv_resident_pages = 0;
    finished_event.finished.cached_kv_page_budget = options_.cached_kv_page_budget;
    request->events.push_back(finished_event);
    RemoveActive(request->internal_id);
  }

  void RemoveActive(int64_t internal_id) {
    auto it = std::find(active_order_.begin(), active_order_.end(), internal_id);
    if (it == active_order_.end()) {
      return;
    }
    const int64_t index = static_cast<int64_t>(std::distance(active_order_.begin(), it));
    active_order_.erase(it);
    if (index < active_cursor_) {
      active_cursor_ = std::max<int64_t>(0, active_cursor_ - 1);
    }
    if (active_cursor_ >= static_cast<int64_t>(active_order_.size())) {
      active_cursor_ = 0;
    }
  }

  void RemoveRequest(int64_t internal_id) {
    RemoveActive(internal_id);
    requests_.erase(internal_id);
  }

  std::vector<float> ForwardToken(int64_t token_id, DenseKvCache& cache) const {
    if (cache.position() >= cache.max_positions()) {
      throw std::runtime_error("native_core_context_window_exceeded");
    }
    std::vector<float> hidden = EmbeddingLookup(model_.token_embedding, token_id);
    const int64_t kv_group_size = model_.config.num_heads / std::max<int64_t>(1, model_.config.num_kv_heads);
    const int64_t position = cache.position();
    for (int64_t layer_index = 0; layer_index < model_.config.num_layers; ++layer_index) {
      const LayerWeights& layer = model_.layers[static_cast<size_t>(layer_index)];
      std::vector<float> normed = RmsNorm(hidden, layer.attn_norm, model_.config.norm_eps);
      std::vector<float> q = MatVec(layer.wq, normed);
      std::vector<float> k = MatVec(layer.wk, normed);
      std::vector<float> v = MatVec(layer.wv, normed);
      for (int64_t head = 0; head < model_.config.num_heads; ++head) {
        ApplyRotaryEmbedding(q, head * model_.head_dim, position);
      }
      for (int64_t kv_head = 0; kv_head < model_.config.num_kv_heads; ++kv_head) {
        ApplyRotaryEmbedding(k, kv_head * model_.head_dim, position);
        cache.SetKey(layer_index, position, kv_head, Slice(k, static_cast<size_t>(kv_head * model_.head_dim), static_cast<size_t>(model_.head_dim)));
        cache.SetValue(layer_index, position, kv_head, Slice(v, static_cast<size_t>(kv_head * model_.head_dim), static_cast<size_t>(model_.head_dim)));
      }

      std::vector<float> attention_combined(static_cast<size_t>(model_.config.hidden_size), 0.0f);
      for (int64_t head = 0; head < model_.config.num_heads; ++head) {
        const int64_t kv_head = head / std::max<int64_t>(1, kv_group_size);
        const int64_t q_offset = head * model_.head_dim;
        std::vector<float> scores(static_cast<size_t>(position + 1), 0.0f);
        for (int64_t timestep = 0; timestep <= position; ++timestep) {
          std::vector<float> key = cache.GetKey(layer_index, timestep, kv_head);
          scores[static_cast<size_t>(timestep)] = Dot(q, key, static_cast<size_t>(q_offset), 0, static_cast<size_t>(model_.head_dim)) / std::sqrt(static_cast<double>(model_.head_dim));
        }
        std::vector<float> weights = Softmax(scores);
        std::vector<float> context(static_cast<size_t>(model_.head_dim), 0.0f);
        for (int64_t timestep = 0; timestep <= position; ++timestep) {
          std::vector<float> value = cache.GetValue(layer_index, timestep, kv_head);
          const float weight = weights[static_cast<size_t>(timestep)];
          for (int64_t dim = 0; dim < model_.head_dim; ++dim) {
            context[static_cast<size_t>(dim)] += value[static_cast<size_t>(dim)] * weight;
          }
        }
        std::copy(context.begin(), context.end(), attention_combined.begin() + q_offset);
      }
      AddInPlace(hidden, MatVec(layer.wo, attention_combined));

      std::vector<float> ffn_input = RmsNorm(hidden, layer.ffn_norm, model_.config.norm_eps);
      std::vector<float> gate = MatVec(layer.w1, ffn_input);
      std::vector<float> up = MatVec(layer.w3, ffn_input);
      std::vector<float> activated(gate.size(), 0.0f);
      for (size_t index = 0; index < gate.size(); ++index) {
        activated[index] = Silu(gate[index]) * up[index];
      }
      AddInPlace(hidden, MatVec(layer.w2, activated));
    }
    cache.advance();
    std::vector<float> output = RmsNorm(hidden, model_.output_norm, model_.config.norm_eps);
    return MatVec(model_.lm_head, output);
  }

  std::vector<float> EmbeddingLookup(const Tensor& tensor, int64_t token_id) const {
    if (tensor.shape.size() != 2) {
      throw std::runtime_error("native_core_embedding_rank_mismatch");
    }
    if (token_id < 0 || token_id >= tensor.shape[0]) {
      throw std::runtime_error("native_core_token_out_of_range");
    }
    return MaterializeRow(tensor, token_id);
  }

  std::vector<float> MatVec(const Tensor& tensor, const std::vector<float>& input) const {
    if (tensor.shape.size() != 2) {
      throw std::runtime_error("native_core_matvec_rank_mismatch");
    }
    const int64_t rows = tensor.shape[0];
    const int64_t cols = tensor.shape[1];
    if (static_cast<int64_t>(input.size()) != cols) {
      throw std::runtime_error("native_core_matvec_shape_mismatch");
    }
    std::vector<float> output(static_cast<size_t>(rows), 0.0f);
    if (tensor.dtype == TensorDType::F32) {
      for (int64_t row = 0; row < rows; ++row) {
        double sum = 0.0;
        size_t offset = static_cast<size_t>(row * cols);
        for (int64_t col = 0; col < cols; ++col) {
          sum += tensor.data_f32[offset + static_cast<size_t>(col)] * input[static_cast<size_t>(col)];
        }
        output[static_cast<size_t>(row)] = static_cast<float>(sum);
      }
      return output;
    }
    for (int64_t row = 0; row < rows; ++row) {
      output[static_cast<size_t>(row)] = DotQuantizedRow(tensor, row, input);
    }
    return output;
  }

  float DotQuantizedRow(const Tensor& tensor, int64_t row, const std::vector<float>& input) const {
    const int64_t cols = tensor.shape[1];
    const int64_t block_size = tensor.block_size > 0 ? tensor.block_size : cols;
    const int64_t blocks_per_row = static_cast<int64_t>(std::ceil(static_cast<double>(cols) / static_cast<double>(block_size)));
    const size_t row_offset = static_cast<size_t>(row * cols);
    double sum = 0.0;
    for (int64_t block = 0; block < blocks_per_row; ++block) {
      const float scale = ResolveQuantScale(tensor, row, block, blocks_per_row);
      const int64_t start = block * block_size;
      const int64_t end = std::min<int64_t>(start + block_size, cols);
      double block_sum = 0.0;
      for (int64_t col = start; col < end; ++col) {
        block_sum += static_cast<double>(tensor.data_q8[row_offset + static_cast<size_t>(col)]) * input[static_cast<size_t>(col)];
      }
      sum += block_sum * scale;
    }
    return static_cast<float>(sum);
  }

  float ResolveQuantScale(const Tensor& tensor, int64_t row, int64_t block, int64_t blocks_per_row) const {
    if (tensor.scales.size() == 1) {
      return tensor.scales[0];
    }
    if (static_cast<int64_t>(tensor.scales.size()) == tensor.shape[0]) {
      return tensor.scales[static_cast<size_t>(row)];
    }
    return tensor.scales[static_cast<size_t>(row * blocks_per_row + block)];
  }

  std::vector<float> MaterializeRow(const Tensor& tensor, int64_t row) const {
    if (tensor.shape.size() != 2) {
      throw std::runtime_error("native_core_materialize_row_rank_mismatch");
    }
    const int64_t cols = tensor.shape[1];
    const size_t offset = static_cast<size_t>(row * cols);
    if (tensor.dtype == TensorDType::F32) {
      return std::vector<float>(tensor.data_f32.begin() + static_cast<long>(offset), tensor.data_f32.begin() + static_cast<long>(offset + static_cast<size_t>(cols)));
    }
    std::vector<float> output(static_cast<size_t>(cols), 0.0f);
    const int64_t block_size = tensor.block_size > 0 ? tensor.block_size : cols;
    const int64_t blocks_per_row = static_cast<int64_t>(std::ceil(static_cast<double>(cols) / static_cast<double>(block_size)));
    for (int64_t block = 0; block < blocks_per_row; ++block) {
      const float scale = ResolveQuantScale(tensor, row, block, blocks_per_row);
      const int64_t start = block * block_size;
      const int64_t end = std::min<int64_t>(start + block_size, cols);
      for (int64_t col = start; col < end; ++col) {
        output[static_cast<size_t>(col)] = static_cast<float>(tensor.data_q8[offset + static_cast<size_t>(col)]) * scale;
      }
    }
    return output;
  }

  std::vector<float> RmsNorm(const std::vector<float>& input, const std::vector<float>& weight, double eps) const {
    double mean_square = 0.0;
    for (float value : input) {
      mean_square += static_cast<double>(value) * static_cast<double>(value);
    }
    mean_square /= std::max<size_t>(1, input.size());
    const double scale = 1.0 / std::sqrt(mean_square + eps);
    std::vector<float> output(input.size(), 0.0f);
    for (size_t index = 0; index < input.size(); ++index) {
      output[index] = static_cast<float>(input[index] * scale * weight[index]);
    }
    return output;
  }

  void AddInPlace(std::vector<float>& target, const std::vector<float>& delta) const {
    for (size_t index = 0; index < target.size(); ++index) {
      target[index] += delta[index];
    }
  }

  double Silu(double value) const {
    return value / (1.0 + std::exp(-value));
  }

  std::vector<float> Softmax(const std::vector<float>& values) const {
    float max_value = -INFINITY;
    for (float value : values) {
      if (value > max_value) {
        max_value = value;
      }
    }
    std::vector<float> output(values.size(), 0.0f);
    double sum = 0.0;
    for (size_t index = 0; index < values.size(); ++index) {
      output[index] = static_cast<float>(std::exp(values[index] - max_value));
      sum += output[index];
    }
    if (sum <= 0.0) {
      sum = 1.0;
    }
    for (float& value : output) {
      value = static_cast<float>(value / sum);
    }
    return output;
  }

  double Dot(const std::vector<float>& left, const std::vector<float>& right, size_t left_offset, size_t right_offset, size_t length) const {
    double sum = 0.0;
    for (size_t index = 0; index < length; ++index) {
      sum += static_cast<double>(left[left_offset + index]) * static_cast<double>(right[right_offset + index]);
    }
    return sum;
  }

  void ApplyRotaryEmbedding(std::vector<float>& vector, int64_t offset, int64_t position) const {
    const int64_t limit = std::min<int64_t>(model_.config.rope_dimension, model_.head_dim);
    for (int64_t index = 0; index + 1 < limit; index += 2) {
      const double exponent = static_cast<double>(index) / std::max<int64_t>(1, limit);
      const double frequency = 1.0 / std::pow(model_.config.rope_theta, exponent);
      const double angle = static_cast<double>(position) * frequency;
      const double cosine = std::cos(angle);
      const double sine = std::sin(angle);
      const double left = vector[static_cast<size_t>(offset + index)];
      const double right = vector[static_cast<size_t>(offset + index + 1)];
      vector[static_cast<size_t>(offset + index)] = static_cast<float>(left * cosine - right * sine);
      vector[static_cast<size_t>(offset + index + 1)] = static_cast<float>(left * sine + right * cosine);
    }
  }

  int64_t SampleToken(const std::vector<float>& logits, const RequestState& request) {
    std::vector<float> adjusted = logits;
    if (request.options.repetition_penalty > 0.0 && request.options.repetition_penalty != 1.0) {
      std::vector<int64_t> recent = request.prompt_tokens;
      recent.insert(recent.end(), request.generated.begin(), request.generated.end());
      for (int64_t token : recent) {
        if (token < 0 || token >= static_cast<int64_t>(adjusted.size())) {
          continue;
        }
        float value = adjusted[static_cast<size_t>(token)];
        adjusted[static_cast<size_t>(token)] = value >= 0.0f
          ? static_cast<float>(value / request.options.repetition_penalty)
          : static_cast<float>(value * request.options.repetition_penalty);
      }
    }
    if (request.options.temperature <= 0.0) {
      return ArgMax(adjusted);
    }
    for (float& value : adjusted) {
      value = static_cast<float>(value / request.options.temperature);
    }

    struct Candidate {
      int64_t token = 0;
      float logit = 0.0f;
    };

    std::vector<Candidate> candidates;
    candidates.reserve(adjusted.size());
    for (size_t index = 0; index < adjusted.size(); ++index) {
      candidates.push_back(Candidate{static_cast<int64_t>(index), adjusted[index]});
    }
    std::sort(candidates.begin(), candidates.end(), [](const Candidate& left, const Candidate& right) {
      return left.logit > right.logit;
    });
    if (request.options.top_k > 0 && static_cast<int64_t>(candidates.size()) > request.options.top_k) {
      candidates.resize(static_cast<size_t>(request.options.top_k));
    }
    std::vector<float> logits_only;
    logits_only.reserve(candidates.size());
    for (const Candidate& candidate : candidates) {
      logits_only.push_back(candidate.logit);
    }
    std::vector<float> probabilities = Softmax(logits_only);
    if (request.options.top_p > 0.0 && request.options.top_p < 1.0) {
      double cumulative = 0.0;
      size_t cutoff = candidates.size();
      for (size_t index = 0; index < probabilities.size(); ++index) {
        cumulative += probabilities[index];
        if (cumulative >= request.options.top_p) {
          cutoff = index + 1;
          break;
        }
      }
      candidates.resize(cutoff);
      logits_only.clear();
      for (const Candidate& candidate : candidates) {
        logits_only.push_back(candidate.logit);
      }
      probabilities = Softmax(logits_only);
    }
    double random = NextRandom();
    double cumulative = 0.0;
    for (size_t index = 0; index < candidates.size(); ++index) {
      cumulative += probabilities[index];
      if (random <= cumulative || index + 1 == candidates.size()) {
        return candidates[index].token;
      }
    }
    return 0;
  }

  int64_t ArgMax(const std::vector<float>& values) const {
    int64_t best_index = 0;
    float best_value = -INFINITY;
    for (size_t index = 0; index < values.size(); ++index) {
      if (values[index] > best_value) {
        best_value = values[index];
        best_index = static_cast<int64_t>(index);
      }
    }
    return best_index;
  }

  double NextRandom() {
    random_state_ = (1664525u * random_state_ + 1013904223u);
    return static_cast<double>(random_state_) / static_cast<double>(UINT32_MAX);
  }

  static double DurationMs(const Clock::time_point& start, const Clock::time_point& end) {
    return static_cast<double>(std::chrono::duration_cast<std::chrono::milliseconds>(end - start).count());
  }

  static std::vector<float> Slice(const std::vector<float>& input, size_t offset, size_t length) {
    return std::vector<float>(input.begin() + static_cast<long>(offset), input.begin() + static_cast<long>(offset + length));
  }

  Model model_;
  std::optional<CharacterTokenizer> tokenizer_;
  SchedulerOptions options_;
  int64_t next_internal_id_ = 1;
  std::deque<int64_t> pending_;
  std::vector<int64_t> active_order_;
  std::unordered_map<int64_t, std::unique_ptr<RequestState>> requests_;
  SchedulerStats stats_;
  int64_t active_cursor_ = 0;
  uint32_t random_state_ = 1;
};

struct BackendWrapper {
  napi_env env = nullptr;
  std::unique_ptr<NativeCoreBackendEngine> backend;
  napi_ref metadata_ref = nullptr;
  std::string format = "unknown";
  bool closed = false;
};

void ThrowIfFailed(napi_env env, napi_status status, const char* message) {
  if (status == napi_ok) {
    return;
  }
  napi_throw_error(env, nullptr, message);
  throw std::runtime_error(message);
}

bool HasNamedProperty(napi_env env, napi_value object, const char* name) {
  bool has_property = false;
  ThrowIfFailed(env, napi_has_named_property(env, object, name, &has_property), "napi_has_named_property_failed");
  return has_property;
}

napi_value GetNamedProperty(napi_env env, napi_value object, const char* name) {
  napi_value value = nullptr;
  ThrowIfFailed(env, napi_get_named_property(env, object, name, &value), "napi_get_named_property_failed");
  return value;
}

std::string GetUtf8String(napi_env env, napi_value value) {
  size_t length = 0;
  ThrowIfFailed(env, napi_get_value_string_utf8(env, value, nullptr, 0, &length), "napi_get_value_string_utf8_failed");
  std::vector<char> buffer(length + 1, '\0');
  ThrowIfFailed(env, napi_get_value_string_utf8(env, value, buffer.data(), buffer.size(), &length), "napi_get_value_string_utf8_failed");
  return std::string(buffer.data(), length);
}

double GetDouble(napi_env env, napi_value value) {
  double result = 0;
  ThrowIfFailed(env, napi_get_value_double(env, value, &result), "napi_get_value_double_failed");
  return result;
}

int64_t GetInt64(napi_env env, napi_value value) {
  int64_t result = 0;
  ThrowIfFailed(env, napi_get_value_int64(env, value, &result), "napi_get_value_int64_failed");
  return result;
}

std::vector<int64_t> GetInt64Array(napi_env env, napi_value value) {
  bool is_array = false;
  ThrowIfFailed(env, napi_is_array(env, value, &is_array), "napi_is_array_failed");
  if (!is_array) {
    throw std::runtime_error("expected_array");
  }
  uint32_t length = 0;
  ThrowIfFailed(env, napi_get_array_length(env, value, &length), "napi_get_array_length_failed");
  std::vector<int64_t> result;
  result.reserve(length);
  for (uint32_t index = 0; index < length; ++index) {
    napi_value element = nullptr;
    ThrowIfFailed(env, napi_get_element(env, value, index, &element), "napi_get_element_failed");
    result.push_back(GetInt64(env, element));
  }
  return result;
}

std::vector<float> GetFloatArray(napi_env env, napi_value value) {
  bool is_array = false;
  ThrowIfFailed(env, napi_is_array(env, value, &is_array), "napi_is_array_failed");
  if (!is_array) {
    throw std::runtime_error("expected_array");
  }
  uint32_t length = 0;
  ThrowIfFailed(env, napi_get_array_length(env, value, &length), "napi_get_array_length_failed");
  std::vector<float> result;
  result.reserve(length);
  for (uint32_t index = 0; index < length; ++index) {
    napi_value element = nullptr;
    ThrowIfFailed(env, napi_get_element(env, value, index, &element), "napi_get_element_failed");
    result.push_back(static_cast<float>(GetDouble(env, element)));
  }
  return result;
}

std::vector<std::string> GetStringArray(napi_env env, napi_value value) {
  bool is_array = false;
  ThrowIfFailed(env, napi_is_array(env, value, &is_array), "napi_is_array_failed");
  if (!is_array) {
    throw std::runtime_error("expected_array");
  }
  uint32_t length = 0;
  ThrowIfFailed(env, napi_get_array_length(env, value, &length), "napi_get_array_length_failed");
  std::vector<std::string> result;
  result.reserve(length);
  for (uint32_t index = 0; index < length; ++index) {
    napi_value element = nullptr;
    ThrowIfFailed(env, napi_get_element(env, value, index, &element), "napi_get_element_failed");
    result.push_back(GetUtf8String(env, element));
  }
  return result;
}

Tensor ParseTensor(napi_env env, napi_value object) {
  Tensor tensor;
  tensor.shape = GetInt64Array(env, GetNamedProperty(env, object, "shape"));
  std::string dtype = HasNamedProperty(env, object, "dtype") ? GetUtf8String(env, GetNamedProperty(env, object, "dtype")) : "f32";
  if (dtype == "q8_0") {
    tensor.dtype = TensorDType::Q8_0;
    std::vector<float> raw_data = GetFloatArray(env, GetNamedProperty(env, object, "data"));
    tensor.data_q8.reserve(raw_data.size());
    for (float value : raw_data) {
      tensor.data_q8.push_back(static_cast<int8_t>(value));
    }
    tensor.scales = GetFloatArray(env, GetNamedProperty(env, object, "scales"));
    tensor.block_size = HasNamedProperty(env, object, "blockSize") ? GetInt64(env, GetNamedProperty(env, object, "blockSize")) : 0;
  } else {
    tensor.dtype = TensorDType::F32;
    tensor.data_f32 = GetFloatArray(env, GetNamedProperty(env, object, "data"));
  }
  return tensor;
}

Tensor RequireTensorFromMap(napi_env env, napi_value tensors_object, const std::string& name) {
  if (!HasNamedProperty(env, tensors_object, name.c_str())) {
    throw std::runtime_error("tensor_missing");
  }
  return ParseTensor(env, GetNamedProperty(env, tensors_object, name.c_str()));
}

Model ParseModel(napi_env env, napi_value checkpoint) {
  Model model;
  napi_value config = GetNamedProperty(env, checkpoint, "config");
  model.config.vocab_size = GetInt64(env, GetNamedProperty(env, config, "vocabSize"));
  model.config.hidden_size = GetInt64(env, GetNamedProperty(env, config, "hiddenSize"));
  model.config.intermediate_size = GetInt64(env, GetNamedProperty(env, config, "intermediateSize"));
  model.config.num_layers = GetInt64(env, GetNamedProperty(env, config, "numLayers"));
  model.config.num_heads = GetInt64(env, GetNamedProperty(env, config, "numHeads"));
  model.config.num_kv_heads = HasNamedProperty(env, config, "numKvHeads")
    ? GetInt64(env, GetNamedProperty(env, config, "numKvHeads"))
    : model.config.num_heads;
  model.config.max_position_embeddings = GetInt64(env, GetNamedProperty(env, config, "maxPositionEmbeddings"));
  model.config.rope_theta = HasNamedProperty(env, config, "ropeTheta")
    ? GetDouble(env, GetNamedProperty(env, config, "ropeTheta"))
    : 10000.0;
  model.config.rope_dimension = HasNamedProperty(env, config, "ropeDimension")
    ? GetInt64(env, GetNamedProperty(env, config, "ropeDimension"))
    : (model.config.hidden_size / model.config.num_heads);
  model.config.norm_eps = HasNamedProperty(env, config, "normEps")
    ? GetDouble(env, GetNamedProperty(env, config, "normEps"))
    : 1e-5;
  model.config.bos_token_id = HasNamedProperty(env, config, "bosTokenId") ? GetInt64(env, GetNamedProperty(env, config, "bosTokenId")) : -1;
  model.config.eos_token_id = HasNamedProperty(env, config, "eosTokenId") ? GetInt64(env, GetNamedProperty(env, config, "eosTokenId")) : -1;
  model.config.pad_token_id = HasNamedProperty(env, config, "padTokenId") ? GetInt64(env, GetNamedProperty(env, config, "padTokenId")) : -1;
  model.head_dim = model.config.hidden_size / std::max<int64_t>(1, model.config.num_heads);

  napi_value tensors = GetNamedProperty(env, checkpoint, "tensors");
  model.token_embedding = RequireTensorFromMap(env, tensors, "token_embedding.weight");
  model.lm_head = RequireTensorFromMap(env, tensors, "lm_head.weight");
  Tensor output_norm_tensor = RequireTensorFromMap(env, tensors, "output_norm.weight");
  model.output_norm = output_norm_tensor.data_f32;

  model.layers.reserve(static_cast<size_t>(model.config.num_layers));
  for (int64_t layer_index = 0; layer_index < model.config.num_layers; ++layer_index) {
    LayerWeights layer;
    const std::string prefix = "layers." + std::to_string(layer_index);
    layer.attn_norm = RequireTensorFromMap(env, tensors, prefix + ".attn_norm.weight").data_f32;
    layer.ffn_norm = RequireTensorFromMap(env, tensors, prefix + ".ffn_norm.weight").data_f32;
    layer.wq = RequireTensorFromMap(env, tensors, prefix + ".attention.wq.weight");
    layer.wk = RequireTensorFromMap(env, tensors, prefix + ".attention.wk.weight");
    layer.wv = RequireTensorFromMap(env, tensors, prefix + ".attention.wv.weight");
    layer.wo = RequireTensorFromMap(env, tensors, prefix + ".attention.wo.weight");
    layer.w1 = RequireTensorFromMap(env, tensors, prefix + ".feed_forward.w1.weight");
    layer.w2 = RequireTensorFromMap(env, tensors, prefix + ".feed_forward.w2.weight");
    layer.w3 = RequireTensorFromMap(env, tensors, prefix + ".feed_forward.w3.weight");
    model.layers.push_back(std::move(layer));
  }
  return model;
}

std::optional<CharacterTokenizer> ParseTokenizer(napi_env env, napi_value checkpoint) {
  if (!HasNamedProperty(env, checkpoint, "tokenizer")) {
    return std::nullopt;
  }
  napi_value tokenizer = GetNamedProperty(env, checkpoint, "tokenizer");
  std::string kind = GetUtf8String(env, GetNamedProperty(env, tokenizer, "kind"));
  if (kind != "character") {
    return std::nullopt;
  }
  std::vector<std::string> vocab = GetStringArray(env, GetNamedProperty(env, tokenizer, "vocab"));
  const int64_t bos = HasNamedProperty(env, tokenizer, "bosTokenId") ? GetInt64(env, GetNamedProperty(env, tokenizer, "bosTokenId")) : -1;
  const int64_t eos = HasNamedProperty(env, tokenizer, "eosTokenId") ? GetInt64(env, GetNamedProperty(env, tokenizer, "eosTokenId")) : -1;
  const int64_t unk = HasNamedProperty(env, tokenizer, "unkTokenId") ? GetInt64(env, GetNamedProperty(env, tokenizer, "unkTokenId")) : -1;
  const int64_t pad = HasNamedProperty(env, tokenizer, "padTokenId") ? GetInt64(env, GetNamedProperty(env, tokenizer, "padTokenId")) : -1;
  return CharacterTokenizer(std::move(vocab), bos, eos, unk, pad);
}

SchedulerOptions ParseSchedulerOptions(napi_env env, napi_value payload) {
  SchedulerOptions options;
  if (!HasNamedProperty(env, payload, "options")) {
    return options;
  }
  napi_value input = GetNamedProperty(env, payload, "options");
  if (HasNamedProperty(env, input, "schedulerMaxBatchSize")) {
    options.max_batch_size = GetInt64(env, GetNamedProperty(env, input, "schedulerMaxBatchSize"));
  }
  if (HasNamedProperty(env, input, "schedulerMaxPrefillsPerTick")) {
    options.max_prefills_per_tick = GetInt64(env, GetNamedProperty(env, input, "schedulerMaxPrefillsPerTick"));
  }
  if (HasNamedProperty(env, input, "seed")) {
    options.seed = static_cast<uint32_t>(GetInt64(env, GetNamedProperty(env, input, "seed")));
  }
  if (HasNamedProperty(env, input, "cachedKvPageBudget")) {
    options.cached_kv_page_budget = GetInt64(env, GetNamedProperty(env, input, "cachedKvPageBudget"));
  }
  return options;
}

RequestOptions ParseRequestOptions(napi_env env, napi_value payload) {
  RequestOptions options;
  if (HasNamedProperty(env, payload, "model")) {
    options.model = GetUtf8String(env, GetNamedProperty(env, payload, "model"));
  }
  if (HasNamedProperty(env, payload, "requestId")) {
    options.request_id = GetUtf8String(env, GetNamedProperty(env, payload, "requestId"));
  }
  if (HasNamedProperty(env, payload, "sessionId")) {
    options.session_id = GetUtf8String(env, GetNamedProperty(env, payload, "sessionId"));
  }
  if (HasNamedProperty(env, payload, "promptTokens")) {
    options.prompt_tokens = GetInt64Array(env, GetNamedProperty(env, payload, "promptTokens"));
  }
  if (HasNamedProperty(env, payload, "maxTokens")) {
    options.max_tokens = GetInt64(env, GetNamedProperty(env, payload, "maxTokens"));
  }
  if (HasNamedProperty(env, payload, "temperature")) {
    options.temperature = GetDouble(env, GetNamedProperty(env, payload, "temperature"));
  }
  if (HasNamedProperty(env, payload, "topK")) {
    options.top_k = GetInt64(env, GetNamedProperty(env, payload, "topK"));
  }
  if (HasNamedProperty(env, payload, "topP")) {
    options.top_p = GetDouble(env, GetNamedProperty(env, payload, "topP"));
  }
  if (HasNamedProperty(env, payload, "repetitionPenalty")) {
    options.repetition_penalty = GetDouble(env, GetNamedProperty(env, payload, "repetitionPenalty"));
  }
  if (HasNamedProperty(env, payload, "stop")) {
    options.stop = GetStringArray(env, GetNamedProperty(env, payload, "stop"));
  }
  return options;
}

BackendWrapper* UnwrapBackend(napi_env env, napi_callback_info info, size_t expected_args, std::vector<napi_value>* args_out) {
  size_t argc = expected_args;
  std::vector<napi_value> args(expected_args);
  napi_value this_arg = nullptr;
  ThrowIfFailed(env, napi_get_cb_info(env, info, &argc, args.data(), &this_arg, nullptr), "napi_get_cb_info_failed");
  BackendWrapper* wrapper = nullptr;
  ThrowIfFailed(env, napi_unwrap(env, this_arg, reinterpret_cast<void**>(&wrapper)), "napi_unwrap_failed");
  if (args_out != nullptr) {
    args.resize(argc);
    *args_out = std::move(args);
  }
  return wrapper;
}

napi_value CreateString(napi_env env, const std::string& value) {
  napi_value result = nullptr;
  ThrowIfFailed(env, napi_create_string_utf8(env, value.c_str(), value.size(), &result), "napi_create_string_utf8_failed");
  return result;
}

napi_value CreateInt64(napi_env env, int64_t value) {
  napi_value result = nullptr;
  ThrowIfFailed(env, napi_create_int64(env, value, &result), "napi_create_int64_failed");
  return result;
}

napi_value CreateDouble(napi_env env, double value) {
  napi_value result = nullptr;
  ThrowIfFailed(env, napi_create_double(env, value, &result), "napi_create_double_failed");
  return result;
}

napi_value CreateBoolean(napi_env env, bool value) {
  napi_value result = nullptr;
  ThrowIfFailed(env, napi_get_boolean(env, value, &result), "napi_get_boolean_failed");
  return result;
}

void SetNamedProperty(napi_env env, napi_value object, const char* name, napi_value value) {
  ThrowIfFailed(env, napi_set_named_property(env, object, name, value), "napi_set_named_property_failed");
}

napi_value CreateFinishedResult(napi_env env, BackendWrapper* wrapper, const FinishedPayload& payload) {
  napi_value result = nullptr;
  ThrowIfFailed(env, napi_create_object(env, &result), "napi_create_object_failed");
  SetNamedProperty(env, result, "text", CreateString(env, payload.text));

  napi_value raw = nullptr;
  ThrowIfFailed(env, napi_create_object(env, &raw), "napi_create_object_failed");
  napi_value native_runtime = nullptr;
  ThrowIfFailed(env, napi_create_object(env, &native_runtime), "napi_create_object_failed");

  SetNamedProperty(env, native_runtime, "text", CreateString(env, payload.text));
  SetNamedProperty(env, native_runtime, "promptTokens", CreateInt64(env, payload.prompt_tokens));
  SetNamedProperty(env, native_runtime, "prefillTokens", CreateInt64(env, payload.prefill_tokens));
  SetNamedProperty(env, native_runtime, "generatedTokens", CreateInt64(env, payload.generated_tokens));
  SetNamedProperty(env, native_runtime, "finishReason", CreateString(env, payload.finish_reason));
  SetNamedProperty(env, native_runtime, "ttftMs", CreateDouble(env, payload.ttft_ms));
  SetNamedProperty(env, native_runtime, "tpotMs", CreateDouble(env, payload.tpot_ms));
  SetNamedProperty(env, native_runtime, "tokensPerSecond", CreateDouble(env, payload.tokens_per_second));
  SetNamedProperty(env, native_runtime, "device", CreateString(env, "cpu"));
  SetNamedProperty(env, native_runtime, "format", CreateString(env, wrapper->format));
  if (!payload.request_id.empty()) {
    SetNamedProperty(env, native_runtime, "requestId", CreateString(env, payload.request_id));
  }
  if (!payload.session_id.empty()) {
    SetNamedProperty(env, native_runtime, "sessionId", CreateString(env, payload.session_id));
  }
  SetNamedProperty(env, native_runtime, "cacheSource", CreateString(env, "cold"));
  SetNamedProperty(env, native_runtime, "queueWaitMs", CreateDouble(env, payload.queue_wait_ms));

  napi_value scheduler = nullptr;
  ThrowIfFailed(env, napi_create_object(env, &scheduler), "napi_create_object_failed");
  SetNamedProperty(env, scheduler, "continuousBatching", CreateBoolean(env, true));
  SetNamedProperty(env, scheduler, "servingBackend", CreateString(env, "native-core"));
  SetNamedProperty(env, scheduler, "maxBatchSize", CreateInt64(env, wrapper->backend->scheduler_stats().peak_active > 0 ? wrapper->backend->scheduler_stats().peak_active : 8));
  SetNamedProperty(env, scheduler, "maxPrefillsPerTick", CreateInt64(env, 1));
  SetNamedProperty(env, scheduler, "kvCacheKind", CreateString(env, "dense"));
  SetNamedProperty(env, scheduler, "activeRequestsAtAdmission", CreateInt64(env, payload.active_requests_at_admission));
  SetNamedProperty(env, scheduler, "queuedRequestsAtAdmission", CreateInt64(env, payload.queued_requests_at_admission));
  SetNamedProperty(env, scheduler, "requestSchedulerCycles", CreateInt64(env, payload.request_scheduler_cycles));
  SetNamedProperty(env, scheduler, "engineSchedulerCycles", CreateInt64(env, payload.engine_scheduler_cycles));
  SetNamedProperty(env, scheduler, "peakActiveRequests", CreateInt64(env, payload.peak_active_requests));
  SetNamedProperty(env, scheduler, "peakQueuedRequests", CreateInt64(env, payload.peak_queued_requests));
  SetNamedProperty(env, native_runtime, "scheduler", scheduler);

  napi_value memory = nullptr;
  ThrowIfFailed(env, napi_create_object(env, &memory), "napi_create_object_failed");
  SetNamedProperty(env, memory, "kvResidentBytes", CreateInt64(env, payload.kv_resident_bytes));
  SetNamedProperty(env, memory, "kvAllocatedPages", CreateInt64(env, payload.kv_allocated_pages));
  SetNamedProperty(env, memory, "cachedKvResidentPages", CreateInt64(env, payload.cached_kv_resident_pages));
  SetNamedProperty(env, memory, "cachedKvPageBudget", CreateInt64(env, payload.cached_kv_page_budget));
  SetNamedProperty(env, native_runtime, "memory", memory);

  if (wrapper->metadata_ref != nullptr) {
    napi_value metadata = nullptr;
    ThrowIfFailed(env, napi_get_reference_value(env, wrapper->metadata_ref, &metadata), "napi_get_reference_value_failed");
    SetNamedProperty(env, native_runtime, "metadata", metadata);
  }
  SetNamedProperty(env, raw, "nativeRuntime", native_runtime);
  SetNamedProperty(env, result, "raw", raw);
  return result;
}

napi_value CreateEvent(napi_env env, BackendWrapper* wrapper, const NativeEvent& event) {
  napi_value output = nullptr;
  ThrowIfFailed(env, napi_create_object(env, &output), "napi_create_object_failed");
  if (event.type == NativeEvent::Type::Started) {
    SetNamedProperty(env, output, "type", CreateString(env, "started"));
    SetNamedProperty(env, output, "model", CreateString(env, event.model));
    return output;
  }
  if (event.type == NativeEvent::Type::Token) {
    SetNamedProperty(env, output, "type", CreateString(env, "token"));
    SetNamedProperty(env, output, "text", CreateString(env, event.text));
    SetNamedProperty(env, output, "index", CreateInt64(env, event.index));
    SetNamedProperty(env, output, "tokenId", CreateInt64(env, event.token_id));
    return output;
  }
  SetNamedProperty(env, output, "type", CreateString(env, "finished"));
  SetNamedProperty(env, output, "result", CreateFinishedResult(env, wrapper, event.finished));
  return output;
}

void FinalizeBackend(napi_env env, void* data, void* /*hint*/) {
  BackendWrapper* wrapper = static_cast<BackendWrapper*>(data);
  if (wrapper == nullptr) {
    return;
  }
  if (wrapper->metadata_ref != nullptr) {
    napi_delete_reference(env, wrapper->metadata_ref);
    wrapper->metadata_ref = nullptr;
  }
  delete wrapper;
}

napi_value BackendIsExecutable(napi_env env, napi_callback_info info) {
  try {
    BackendWrapper* wrapper = UnwrapBackend(env, info, 0, nullptr);
    return CreateBoolean(env, wrapper->backend->is_executable());
  } catch (const std::exception& error) {
    napi_throw_error(env, nullptr, error.what());
    return nullptr;
  }
}

napi_value BackendSubmit(napi_env env, napi_callback_info info) {
  try {
    std::vector<napi_value> args;
    BackendWrapper* wrapper = UnwrapBackend(env, info, 1, &args);
    if (args.empty()) {
      throw std::runtime_error("native_core_submit_requires_payload");
    }
    RequestOptions options = ParseRequestOptions(env, args[0]);
    std::string prompt = GetUtf8String(env, GetNamedProperty(env, args[0], "prompt"));
    const int64_t internal_id = wrapper->backend->Submit(prompt, options);
    return CreateInt64(env, internal_id);
  } catch (const std::exception& error) {
    napi_throw_error(env, nullptr, error.what());
    return nullptr;
  }
}

napi_value BackendPoll(napi_env env, napi_callback_info info) {
  try {
    std::vector<napi_value> args;
    BackendWrapper* wrapper = UnwrapBackend(env, info, 2, &args);
    if (args.empty()) {
      throw std::runtime_error("native_core_poll_requires_request_id");
    }
    const int64_t internal_id = GetInt64(env, args[0]);
    const int64_t max_events = args.size() > 1 ? GetInt64(env, args[1]) : 16;
    std::vector<NativeEvent> events = wrapper->backend->Poll(internal_id, max_events);
    napi_value array = nullptr;
    ThrowIfFailed(env, napi_create_array_with_length(env, events.size(), &array), "napi_create_array_with_length_failed");
    for (size_t index = 0; index < events.size(); ++index) {
      ThrowIfFailed(env, napi_set_element(env, array, static_cast<uint32_t>(index), CreateEvent(env, wrapper, events[index])), "napi_set_element_failed");
    }
    return array;
  } catch (const std::exception& error) {
    napi_throw_error(env, nullptr, error.what());
    return nullptr;
  }
}

napi_value BackendCancel(napi_env env, napi_callback_info info) {
  try {
    std::vector<napi_value> args;
    BackendWrapper* wrapper = UnwrapBackend(env, info, 1, &args);
    if (!args.empty()) {
      wrapper->backend->Cancel(GetInt64(env, args[0]));
    }
    napi_value undefined_value = nullptr;
    ThrowIfFailed(env, napi_get_undefined(env, &undefined_value), "napi_get_undefined_failed");
    return undefined_value;
  } catch (const std::exception& error) {
    napi_throw_error(env, nullptr, error.what());
    return nullptr;
  }
}

napi_value BackendSchedulerMetrics(napi_env env, napi_callback_info info) {
  try {
    BackendWrapper* wrapper = UnwrapBackend(env, info, 0, nullptr);
    SchedulerStats stats = wrapper->backend->scheduler_stats();
    napi_value object = nullptr;
    ThrowIfFailed(env, napi_create_object(env, &object), "napi_create_object_failed");
    SetNamedProperty(env, object, "submitted", CreateInt64(env, stats.submitted));
    SetNamedProperty(env, object, "completed", CreateInt64(env, stats.completed));
    SetNamedProperty(env, object, "failed", CreateInt64(env, stats.failed));
    SetNamedProperty(env, object, "cancelled", CreateInt64(env, stats.cancelled));
    SetNamedProperty(env, object, "cycles", CreateInt64(env, stats.cycles));
    SetNamedProperty(env, object, "prefills", CreateInt64(env, stats.prefills));
    SetNamedProperty(env, object, "decodeSteps", CreateInt64(env, stats.decode_steps));
    SetNamedProperty(env, object, "peakActive", CreateInt64(env, stats.peak_active));
    SetNamedProperty(env, object, "peakQueued", CreateInt64(env, stats.peak_queued));
    return object;
  } catch (const std::exception& error) {
    napi_throw_error(env, nullptr, error.what());
    return nullptr;
  }
}

napi_value BackendClose(napi_env env, napi_callback_info info) {
  try {
    BackendWrapper* wrapper = UnwrapBackend(env, info, 0, nullptr);
    wrapper->backend.reset();
    wrapper->closed = true;
    napi_value undefined_value = nullptr;
    ThrowIfFailed(env, napi_get_undefined(env, &undefined_value), "napi_get_undefined_failed");
    return undefined_value;
  } catch (const std::exception& error) {
    napi_throw_error(env, nullptr, error.what());
    return nullptr;
  }
}

napi_value CreateBackendObject(napi_env env, BackendWrapper* wrapper) {
  napi_value object = nullptr;
  ThrowIfFailed(env, napi_create_object(env, &object), "napi_create_object_failed");
  ThrowIfFailed(env, napi_wrap(env, object, wrapper, FinalizeBackend, nullptr, nullptr), "napi_wrap_failed");

  napi_property_descriptor properties[] = {
    {"isExecutable", nullptr, BackendIsExecutable, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"submit", nullptr, BackendSubmit, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"poll", nullptr, BackendPoll, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"cancel", nullptr, BackendCancel, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"schedulerMetrics", nullptr, BackendSchedulerMetrics, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"close", nullptr, BackendClose, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  ThrowIfFailed(env, napi_define_properties(env, object, sizeof(properties) / sizeof(properties[0]), properties), "napi_define_properties_failed");
  return object;
}

napi_value CreateBackend(napi_env env, napi_callback_info info) {
  try {
    size_t argc = 1;
    napi_value args[1];
    ThrowIfFailed(env, napi_get_cb_info(env, info, &argc, args, nullptr, nullptr), "napi_get_cb_info_failed");
    if (argc < 1) {
      napi_throw_error(env, nullptr, "native_core_create_backend_requires_payload");
      return nullptr;
    }

    napi_value payload = args[0];
    napi_value checkpoint = GetNamedProperty(env, payload, "checkpoint");
    Model model = ParseModel(env, checkpoint);
    std::optional<CharacterTokenizer> tokenizer = ParseTokenizer(env, checkpoint);
    SchedulerOptions scheduler_options = ParseSchedulerOptions(env, payload);

    auto* wrapper = new BackendWrapper();
    wrapper->env = env;
    wrapper->backend = std::make_unique<NativeCoreBackendEngine>(std::move(model), std::move(tokenizer), scheduler_options);
    if (HasNamedProperty(env, payload, "metadata")) {
      ThrowIfFailed(env, napi_create_reference(env, GetNamedProperty(env, payload, "metadata"), 1, &wrapper->metadata_ref), "napi_create_reference_failed");
      if (HasNamedProperty(env, GetNamedProperty(env, payload, "metadata"), "format")) {
        wrapper->format = GetUtf8String(env, GetNamedProperty(env, GetNamedProperty(env, payload, "metadata"), "format"));
      }
    }
    return CreateBackendObject(env, wrapper);
  } catch (const std::exception& error) {
    napi_throw_error(env, nullptr, error.what());
    return nullptr;
  }
}

napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
    {"createBackend", nullptr, CreateBackend, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  ThrowIfFailed(env, napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties), "napi_define_properties_failed");

  // Export optional CUDA API under `exports.cuda`.
  napi_value cuda;
  ThrowIfFailed(env, napi_create_object(env, &cuda), "napi_create_object_failed");
  napi_property_descriptor cudaProps[] = {
    {"deviceInfo", nullptr, CudaDeviceInfo, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"malloc", nullptr, CudaMalloc, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"memcpyHtoD", nullptr, CudaMemcpyHtoD, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"memcpyDtoH", nullptr, CudaMemcpyDtoH, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"free", nullptr, CudaFree, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  ThrowIfFailed(env, napi_define_properties(env, cuda, sizeof(cudaProps) / sizeof(cudaProps[0]), cudaProps), "napi_define_properties_failed");
  ThrowIfFailed(env, napi_set_named_property(env, exports, "cuda", cuda), "napi_set_named_property_failed");

  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
