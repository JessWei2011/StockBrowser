import asyncio
import json
import logging
import urllib.request
from datetime import datetime, timezone
from typing import Optional, Any
from backend.app.settings import settings
from backend.app.repositories import db

logger = logging.getLogger("ai_note_service")

# 個股 AI 筆記生成 Prompt
PROMPT_TEMPLATE = """
你是資深台股電子與半導體產業分析師。請為台股代碼「{code}」、名稱「{name}」撰寫繁體中文簡明產業分析筆記。
請嚴格以 JSON 格式回傳，欄位要求如下：
{{
  "business": "主要業務做什麼、產業地位與核心產品（控制在 30~45 字以內）",
  "customers": "主要客戶有誰（包含一線伺服器/品牌ODM、代工廠或CSP終端巨頭，控制在 30~45 字以內）",
  "ai_relation": "與AI產業/算力供應鏈交會的關鍵項目與應用（如 GPU 加速卡、伺服器、高階交換機、散熱、先進封裝等，控制在 35~50 字以內）"
}}

注意事項：
1. 嚴格輸出正體中文（台灣習慣用語，例如：伺服器、封裝、散熱、銅箔基板、交換機、輝達、台積電等）。
2. 每段言簡意賅、直擊要害，不要有「該公司成立於...」等冗詞贅字。
3. 若該公司非純 AI 概念股，亦請精確點出其產品是否有切入 AI 或相關供應鏈，若無則說明其利基市場。
4. 務必僅輸出合法 JSON，不要加上 Markdown 區塊或任何前言與結尾。
"""

class AiNoteService:
    def __init__(self):
        self._cache: dict[str, dict] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._global_lock = asyncio.Lock()

    def _get_stock_lock(self, code: str) -> asyncio.Lock:
        if code not in self._locks:
            self._locks[code] = asyncio.Lock()
        return self._locks[code]

    async def get_all_notes(self) -> dict[str, dict]:
        """獲取所有快取的 AI 筆記"""
        notes = await db.get_all_stock_ai_notes()
        self._cache.update(notes)
        return self._cache

    async def get_note(self, code: str) -> Optional[dict]:
        """獲取單檔股票的 AI 筆記（若快取沒有則查 DB）"""
        if code in self._cache:
            return self._cache[code]
        note = await db.get_stock_ai_note(code)
        if note:
            self._cache[code] = note
            return note
        return None

    async def generate_note(self, code: str, name: str = "", force: bool = False) -> dict:
        """
        生成或獲取個股 AI 筆記。
        若 force=False 且已有快取/DB，直接回傳。
        若無快取或 force=True，呼叫 Gemini API 生成並寫入 DB。
        """
        async with self._get_stock_lock(code):
            if not force:
                existing = await self.get_note(code)
                if existing and existing.get("business"):
                    return existing

            api_key = settings.GEMINI_API_KEY
            if not api_key:
                logger.warning(f"GEMINI_API_KEY is not configured, cannot generate note for {code}")
                # 若無 API Key 但資料庫已有舊資料，回傳舊資料
                existing = await self.get_note(code)
                if existing:
                    return existing
                return {
                    "code": code,
                    "name": name,
                    "business": "尚未設定 GEMINI_API_KEY，無法自動生成。",
                    "customers": "請於後端環境變數設定 GEMINI_API_KEY。",
                    "ai_relation": "設定完成後可點擊重新生成。",
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                    "error": "MISSING_API_KEY"
                }

            logger.info(f"Generating AI note for {code} ({name}) via Gemini API...")
            prompt = PROMPT_TEMPLATE.format(code=code, name=name or code)
            
            # 使用 ThreadPool 呼叫 Gemini REST API
            loop = asyncio.get_running_loop()
            res_data = await loop.run_in_executor(None, self._call_gemini_api, api_key, prompt)

            if not res_data or "error" in res_data:
                err_msg = res_data.get("error", "未知錯誤") if res_data else "API 連線逾時"
                logger.error(f"Failed to generate note for {code}: {err_msg}")
                existing = await self.get_note(code)
                if existing:
                    return existing
                return {
                    "code": code,
                    "name": name,
                    "business": f"生成失敗：{err_msg}",
                    "customers": "請檢查網路連線或 API 配額。",
                    "ai_relation": "點擊下方重新生成即可再次嘗試。",
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                    "error": err_msg
                }

            business = (res_data.get("business") or "").strip()
            customers = (res_data.get("customers") or "").strip()
            ai_relation = (res_data.get("ai_relation") or "").strip()
            raw_text = f"【業務】{business}\n【客戶】{customers}\n【AI交會】{ai_relation}"

            saved = await db.save_stock_ai_note(
                code=code,
                name=name,
                business=business,
                customers=customers,
                ai_relation=ai_relation,
                raw_text=raw_text
            )
            self._cache[code] = saved
            logger.info(f"Successfully generated and cached AI note for {code} ({name})")
            return saved

    def _call_gemini_api(self, api_key: str, prompt: str) -> dict:
        """同步呼叫 Gemini 2.5 Flash API，傳回解析後的 dict"""
        url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={api_key}"
        payload = {
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {
                "responseMimeType": "application/json",
                "maxOutputTokens": 2048,
                "temperature": 0.2
            }
        }
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                res = json.loads(resp.read().decode("utf-8"))
                candidates = res.get("candidates", [])
                if not candidates:
                    return {"error": "Gemini API 未回傳內容"}
                text = candidates[0].get("content", {}).get("parts", [{}])[0].get("text", "")
                if not text:
                    return {"error": "Gemini API 回傳空內容"}
                # 清除可能的 markdown code fence
                clean_text = text.strip()
                if clean_text.startswith("```json"):
                    clean_text = clean_text[7:]
                if clean_text.startswith("```"):
                    clean_text = clean_text[3:]
                if clean_text.endswith("```"):
                    clean_text = clean_text[:-3]
                clean_text = clean_text.strip()
                parsed = json.loads(clean_text)
                return parsed
        except urllib.error.HTTPError as e:
            try:
                err_body = e.read().decode("utf-8")
                logger.error(f"Gemini API HTTP Error {e.code}: {err_body}")
                return {"error": f"HTTP {e.code}: {e.reason}"}
            except Exception:
                return {"error": f"HTTP {e.code}"}
        except Exception as e:
            logger.error(f"Gemini API request exception: {e}")
            return {"error": str(e)}

    async def update_note(self, code: str, business: str, customers: str, ai_relation: str, name: str = "") -> dict:
        """手動更新筆記內容"""
        raw_text = f"【業務】{business}\n【客戶】{customers}\n【AI交會】{ai_relation}"
        saved = await db.save_stock_ai_note(
            code=code,
            name=name,
            business=business,
            customers=customers,
            ai_relation=ai_relation,
            raw_text=raw_text
        )
        self._cache[code] = saved
        return saved

    async def ensure_note(self, code: str, name: str = ""):
        """新增自選股時背景呼叫，確保該個股已有 AI 筆記"""
        try:
            existing = await self.get_note(code)
            if not existing or not existing.get("business"):
                await self.generate_note(code, name, force=False)
        except Exception as e:
            logger.warning(f"Background ensure_note for {code} failed: {e}")

ai_note_service = AiNoteService()
