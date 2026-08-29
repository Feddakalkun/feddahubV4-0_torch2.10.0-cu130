import logging
import logging.handlers
from pathlib import Path

# Endpoints the browser polls on a timer. Between them they produce a line
# every half second forever, and the console scrolls away anything worth
# reading - a traceback, a refused prompt, the one warning that explains what
# just went wrong. The run window is the only place most people will ever look
# for that.
#
# Prefixes, because three of these carry an id.
_POLLED_PATHS = (
    "/api/generate/status/",
    "/api/hardware/stats",
    "/api/workflow/download-live-progress/",
    "/api/system/comfy-status",
)


class QuietPolling(logging.Filter):
    """Drop successful polls from the access log, keep everything else.

    Not access_log=False: a 404 on a route the frontend calls, or a 500 from a
    handler, is exactly what the window is for. Only 2xx and 3xx on the paths
    above are dropped, and only from the console: this hangs on the stream
    handler, so logs/backend.log still records every one of them, which is
    where you go when you want the sequence of requests.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        args = record.args
        # uvicorn logs '%s - "%s %s HTTP/%s" %d' with
        # (client, method, path, version, status). Anything else is not an
        # access line and is none of this filter's business.
        if not isinstance(args, tuple) or len(args) < 5:
            return True
        try:
            status = int(args[4])
        except (TypeError, ValueError):
            return True
        if status >= 400:
            return True
        path = str(args[2]).split("?", 1)[0]
        return not path.startswith(_POLLED_PATHS)


def setup_logging(log_dir: Path | None = None) -> None:
    if log_dir is None:
        log_dir = Path(__file__).parent.parent / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)

    fmt = logging.Formatter(
        "%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    root = logging.getLogger()
    if root.handlers:
        return  # already configured (e.g. during hot-reload)
    root.setLevel(logging.DEBUG)

    fh = logging.handlers.RotatingFileHandler(
        log_dir / "backend.log",
        maxBytes=5 * 1024 * 1024,
        backupCount=3,
        encoding="utf-8",
    )
    fh.setLevel(logging.DEBUG)
    fh.setFormatter(fmt)
    root.addHandler(fh)

    ch = logging.StreamHandler()
    ch.setLevel(logging.INFO)
    ch.setFormatter(fmt)
    # On the console handler, not on the uvicorn.access logger: a filter
    # on a logger drops the record before any handler sees it, which would
    # take the polls out of backend.log as well. The file is where you go
    # to reconstruct what the browser actually asked for, so it keeps them.
    ch.addFilter(QuietPolling())
    root.addHandler(ch)

    # Suppress noisy third-party loggers
    # uvicorn.access stays at INFO on purpose. Raising it to WARNING silenced
    # the polls and every 4xx and 5xx with them - and it did not even hold:
    # uvicorn.run reapplies its own log config after this runs, so the level
    # was put straight back. server.py passes log_config=None for that reason.
    # The filter is what does the work, and it survives a setLevel.
    logging.getLogger("uvicorn.access").setLevel(logging.INFO)
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
