"""Test-only: subprocess embedder stub for ingest worker tests."""
import hashlib
import sys

class _HashEmbedder:
    DIM = 32
    def embed(self, texts):
        out = []
        for t in texts:
            h = hashlib.sha256(t.encode('utf-8')).digest()
            out.append([(b / 255.0) * 2.0 - 1.0 for b in h[: self.DIM]])
        return out
    def embed_query(self, t):
        return self.embed([t])[0]

_STUB = _HashEmbedder()

def _factory(*_a, **_kw):
    return _STUB

_original_setitem = type(sys.modules).__setitem__

def _patch_if_target(name, module):
    if name == 'pipeline.embeddings' and hasattr(module, 'get_embedder'):
        module.get_embedder = _factory
    if name == 'pipeline.ingest' and hasattr(module, 'get_embedder'):
        module.get_embedder = _factory

class _PatchOnSet(dict):
    def __setitem__(self, key, value):
        _original_setitem(self, key, value)
        try:
            _patch_if_target(key, value)
        except Exception:
            pass

# Already-imported modules: patch immediately. New imports: hook setitem.
for _n in list(sys.modules):
    try:
        _patch_if_target(_n, sys.modules[_n])
    except Exception:
        pass

# Override sys.modules to intercept future imports.
# We can't replace sys.modules wholesale (CPython caches a reference),
# so we use an import hook instead.
import importlib.abc
import importlib.util

class _StubFinder(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path, target=None):
        if fullname not in ('pipeline.embeddings', 'pipeline.ingest'):
            return None
        # Let the real loader run; we patch in a post-load hook.
        for finder in sys.meta_path:
            if finder is self:
                continue
            spec = finder.find_spec(fullname, path, target)
            if spec is None:
                continue
            original_loader = spec.loader
            if original_loader is None:
                return spec
            original_exec = original_loader.exec_module
            def _wrapped_exec(module, _orig=original_exec, _name=fullname):
                _orig(module)
                _patch_if_target(_name, module)
            original_loader.exec_module = _wrapped_exec  # type: ignore[method-assign]
            return spec
        return None

sys.meta_path.insert(0, _StubFinder())
