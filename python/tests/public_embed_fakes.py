"""Narrow stdlib adapters for the operations used by engine.embed.

This is a synthetic backend, not an ONNX reader, tokenizer implementation, or
NumPy substitute for general use. Production warmup/embed/selfcheck are never
patched. Known CLS rows and deliberately different non-CLS rows expose pooling
and normalization errors without optional imports or real model artifacts.
"""
import copy
from importlib.machinery import ModuleSpec
import math
from pathlib import Path
from types import ModuleType, SimpleNamespace


def _shape(value):
    if not isinstance(value, list):
        return ()
    return (len(value),) + (_shape(value[0]) if value else ())


def _map(value, operation):
    return [_map(item, operation) for item in value] if isinstance(value, list) else operation(value)


def _flat(value):
    if isinstance(value, list):
        return [number for item in value for number in _flat(item)]
    return [value]


def _select(value, indexes):
    if not indexes:
        return value
    first, rest = indexes[0], indexes[1:]
    if isinstance(first, slice):
        return [_select(item, rest) for item in value[first]]
    return _select(value[first], rest)


class FakeTensor:
    """Nested-list tensor; only the indexing/arithmetic used by embed is defined."""

    def __init__(self, values, dtype="float32", shape=None):
        self.values = copy.deepcopy(values)
        self.shape = tuple(shape) if shape is not None else _shape(values)
        self.dtype = dtype

    def __getitem__(self, index):
        indexes = index if isinstance(index, tuple) else (index,)
        value = _select(self.values, indexes)
        return FakeTensor(value, self.dtype) if isinstance(value, list) else value

    def __setitem__(self, index, values):
        row, columns = index
        if not isinstance(row, int) or not isinstance(columns, slice):
            raise AssertionError("adapter supports only matrix row-slice assignment")
        self.values[row][columns] = list(values)

    def __eq__(self, other):
        return FakeTensor(_map(self.values, lambda item: item == other), dtype="bool",
                          shape=self.shape)

    def __ne__(self, other):
        return FakeTensor(_map(self.values, lambda item: item != other), dtype="bool",
                          shape=self.shape)

    def __truediv__(self, other):
        if other.shape != (self.shape[0], 1):
            raise AssertionError("adapter supports only row-wise division")
        return FakeTensor([
            [number / other.values[row][0] for number in values]
            for row, values in enumerate(self.values)
        ], shape=self.shape)

    def astype(self, dtype):
        return FakeTensor(self.values, dtype=dtype, shape=self.shape)

    def min(self):
        return min(_flat(self.values))

    def tolist(self):
        return copy.deepcopy(self.values)


def _zeros(shape, dtype):
    def build(dimensions):
        if not dimensions:
            return 0
        return [build(dimensions[1:]) for _ in range(dimensions[0])]
    return FakeTensor(build(tuple(shape)), dtype=dtype, shape=shape)


def _norm(tensor, axis=1, keepdims=False):
    if axis != 1 or len(tensor.shape) != 2:
        raise AssertionError("adapter supports only matrix row L2 norms")
    values = [math.sqrt(math.fsum(value * value for value in row))
              for row in tensor.values]
    return FakeTensor([[value] for value in values] if keepdims else values)


def _where(condition, when_true, when_false):
    if condition.shape != when_false.shape:
        raise AssertionError("adapter requires equal condition/value shapes")
    return FakeTensor([
        [when_true if flag else value for flag, value in zip(flags, values)]
        for flags, values in zip(condition.values, when_false.values)
    ])


def _allclose(tensor, expected, atol=1e-8):
    return all(abs(value - expected) <= atol for value in _flat(tensor.values))


def _vstack(tensors):
    width = tensors[0].shape[1]
    rows = [row for tensor in tensors for row in tensor.values]
    return FakeTensor(rows, dtype=tensors[0].dtype, shape=(len(rows), width))


def _array_equal(left, right):
    return left.shape == right.shape and left.values == right.values


def _module(name):
    module = ModuleType(name)
    module.__spec__ = ModuleSpec(name, loader=None)
    return module


class SyntheticEmbeddingBackend:
    """Build three importable fake modules without loading optional packages."""

    def __init__(self):
        self.sessions = []
        self.options = []
        self.tokenizer_paths = []
        self.truncation_lengths = []
        self.batch_texts = []
        self.runs = []

    def modules(self):
        numpy = _module("numpy")
        numpy.int64 = "int64"
        numpy.float32 = "float32"
        numpy.asarray = lambda values, dtype: FakeTensor(values, dtype=dtype)
        numpy.zeros = _zeros
        numpy.linalg = SimpleNamespace(norm=_norm)
        numpy.where = _where
        numpy.vstack = _vstack
        numpy.allclose = _allclose
        numpy.array_equal = _array_equal
        numpy.any = lambda tensor: any(_flat(tensor.values))
        numpy.abs = lambda tensor: FakeTensor(_map(tensor.values, abs), shape=tensor.shape)

        ort = _module("onnxruntime")
        ort.SessionOptions = self._session_options
        ort.GraphOptimizationLevel = SimpleNamespace(ORT_ENABLE_ALL="synthetic-all")
        ort.InferenceSession = self._session

        tokenizers = _module("tokenizers")
        tokenizers.Tokenizer = SimpleNamespace(from_file=self._tokenizer)
        return {"numpy": numpy, "onnxruntime": ort, "tokenizers": tokenizers}

    def _session_options(self):
        options = SimpleNamespace()
        self.options.append(options)
        return options

    def _session(self, path, sess_options, providers):
        if Path(path).read_bytes() != b"synthetic model bytes; not an ONNX artifact\n":
            raise AssertionError("adapter received an unexpected model fixture")
        session = SimpleNamespace(path=path, options=sess_options, providers=list(providers))
        session.get_inputs = lambda: [
            SimpleNamespace(name="input_ids"), SimpleNamespace(name="attention_mask")]
        session.get_providers = lambda: list(session.providers)
        session.run = self._run
        self.sessions.append(session)
        return session

    def _tokenizer(self, path):
        if Path(path).read_text(encoding="utf-8") != '{"adapter":"synthetic"}\n':
            raise AssertionError("adapter received an unexpected tokenizer fixture")
        self.tokenizer_paths.append(path)
        return SimpleNamespace(encode=self._encode, encode_batch=self._encode_batch,
                               enable_truncation=self._enable_truncation)

    def _enable_truncation(self, max_length):
        self.truncation_lengths.append(max_length)

    def _encode(self, text):
        # The literal public table chooses one of two known, nonzero CLS vectors.
        beta = text in ("fixture-beta", "今天天气不错")
        ids = [22, 201, 202, 203] if beta else [11, 101, 102]
        if self.truncation_lengths:
            ids = ids[:self.truncation_lengths[-1]]
        return SimpleNamespace(ids=ids, attention_mask=[1] * len(ids), type_ids=[0] * len(ids))

    def _encode_batch(self, texts):
        self.batch_texts.append(list(texts))
        return [self._encode(text) for text in texts]

    def _run(self, requested, feeds):
        if requested is not None or set(feeds) != {"input_ids", "attention_mask"}:
            raise AssertionError("production must filter feeds to declared model inputs")
        ids, mask = feeds["input_ids"], feeds["attention_mask"]
        if ids.shape != mask.shape:
            raise AssertionError("input/mask shapes differ")
        output = []
        for row in ids.values:
            cls = ([0.0, 5.0, 12.0] + [0.0] * 509
                   if row[0] == 22 else [3.0, 4.0] + [0.0] * 510)
            # These rows must have no effect: the contract requires CLS pooling.
            other = [1000.0, -1000.0] + [0.0] * 510
            output.append([cls] + [list(other) for _ in row[1:]])
        tensor = FakeTensor(output)
        self.runs.append({"feeds": feeds, "output_shape": tensor.shape})
        return [tensor]
