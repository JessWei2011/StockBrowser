from typing import Optional, Literal
from pydantic import BaseModel, Field

DataStatus = Literal['live', 'stale', 'initializing', 'closed', 'error']

class QuoteState(BaseModel):
    code: str
    name: str = ""
    exchange: str = "TSE"
    securityType: str = "STOCK"
    last: Optional[float] = None
    bid: Optional[float] = None
    ask: Optional[float] = None
    open: Optional[float] = None
    high: Optional[float] = None
    low: Optional[float] = None
    totalVolume: Optional[int] = None
    previousClose: Optional[float] = None
    change: Optional[float] = None
    changePercent: Optional[float] = None
    sourceTs: Optional[str] = None
    receivedAt: str = ""
    dataStatus: DataStatus = "initializing"
    revision: int = 0

class WatchlistItem(BaseModel):
    id: str
    groupId: str
    code: str
    name: str
    exchange: str
    securityType: str
    position: int

class WatchlistGroup(BaseModel):
    id: str
    name: str
    position: int
    createdAt: str
    updatedAt: str
    items: list[WatchlistItem] = []

class CreateGroupRequest(BaseModel):
    name: str

class UpdateGroupRequest(BaseModel):
    name: Optional[str] = None
    position: Optional[int] = None

class AddItemRequest(BaseModel):
    code: str

class ReorderItemsRequest(BaseModel):
    codes: list[str]

class InstrumentSearchResult(BaseModel):
    code: str
    name: str
    exchange: str
    securityType: str
    reference: Optional[float] = None
