import hashlib
from dataclasses import dataclass


@dataclass
class Posting:
    source: str
    external_id: str
    title: str
    url: str = ""
    body: str = ""
    org: str = ""
    deadline: str = ""   # ISO date if the source provides one
    posted_at: str = ""

    @property
    def id(self) -> str:
        return hashlib.sha1(f"{self.source}:{self.external_id}".encode()).hexdigest()[:12]

    @property
    def text(self) -> str:
        return f"{self.title}\n{self.body}"
