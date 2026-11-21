import importlib.util
import os
from pathlib import Path
from threading import Lock


MODEL_ID = "Qwen/Qwen3-Reranker-0.6B"
MAX_TOKENS = 1024
BATCH_SIZE = 4
PREFIX = (
    "<|im_start|>system\nJudge whether the Document meets the requirements based on the Query "
    'and the Instruct provided. Note that the answer can only be "yes" or "no".'
    "<|im_end|>\n<|im_start|>user\n"
)
SUFFIX = "<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n"
INSTRUCTION = "Retrieve research passages that contain evidence relevant to the query."


class RerankerUnavailable(Exception):
    pass


def model_directory():
    if not all(importlib.util.find_spec(name) for name in ("torch", "transformers", "huggingface_hub")):
        raise RerankerUnavailable
    custom_path = os.environ.get("KOODO_RERANKER_MODEL_DIR", "").strip()
    if custom_path:
        folder = Path(custom_path).resolve()
    else:
        from huggingface_hub import try_to_load_from_cache

        weights = try_to_load_from_cache(MODEL_ID, "model.safetensors")
        if not isinstance(weights, str):
            raise RerankerUnavailable
        folder = Path(weights).parent
    if not all((folder / file).is_file() for file in ("config.json", "tokenizer.json", "model.safetensors")):
        raise RerankerUnavailable
    return folder


def available():
    try:
        model_directory()
        return True
    except RerankerUnavailable:
        return False


class QwenReranker:
    def __init__(self):
        self.lock = Lock()
        self.model = None

    def rank(self, query, documents):
        with self.lock:
            if self.model is None:
                self.load()
            return self.score(query, documents)

    def load(self):
        folder = model_directory()
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer

        torch.set_num_threads(min(6, os.cpu_count() or 1))
        tokenizer = AutoTokenizer.from_pretrained(folder, local_files_only=True, padding_side="left")
        model = AutoModelForCausalLM.from_pretrained(
            folder, local_files_only=True, use_safetensors=True, dtype=torch.float32,
        ).eval()
        self.tokenizer = tokenizer
        self.prefix = tokenizer.encode(PREFIX, add_special_tokens=False)
        self.suffix = tokenizer.encode(SUFFIX, add_special_tokens=False)
        self.token_ids = tokenizer.convert_tokens_to_ids(["no", "yes"])
        self.model = model

    def score(self, query, documents):
        import torch

        tokenizer = self.tokenizer
        query_tokens = tokenizer.encode(
            f"<Instruct>: {INSTRUCTION}\n<Query>: {query}",
            add_special_tokens=False, truncation=True, max_length=256,
        )
        prefix = self.prefix + query_tokens + tokenizer.encode("\n<Document>: ", add_special_tokens=False)
        budget = MAX_TOKENS - len(prefix) - len(self.suffix)
        scores = []
        with torch.inference_mode():
            for start in range(0, len(documents), BATCH_SIZE):
                texts = documents[start:start + BATCH_SIZE]
                encoded = tokenizer(texts, add_special_tokens=False, truncation=True, max_length=budget)
                batch = tokenizer.pad(
                    {"input_ids": [prefix + tokens + self.suffix for tokens in encoded.input_ids]},
                    padding=True, return_tensors="pt",
                )
                logits = self.model(**batch, use_cache=False, logits_to_keep=1).logits[:, -1, self.token_ids]
                scores.extend(logits.float().softmax(dim=-1)[:, 1].tolist())
        return sorted(range(len(scores)), key=scores.__getitem__, reverse=True)


reranker = QwenReranker()
