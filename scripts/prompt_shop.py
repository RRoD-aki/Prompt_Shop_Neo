from modules import script_callbacks
import gradio as gr

from fastapi import UploadFile, File, Request
from fastapi.responses import Response
from pydantic import BaseModel
import json
import os
import shutil
import time
import io
import urllib.parse

from PIL import Image, PngImagePlugin


class PromptShopData(BaseModel):
    settings: dict
    prompts: list


class PromptShopCardPngExport(BaseModel):
    title: str = ""
    prompt: str = ""
    image: str = "assets/no-image.png"


def get_ext_dir():
    return os.path.dirname(os.path.dirname(__file__))


def get_assets_dir():
    return os.path.join(get_ext_dir(), "assets")


def get_user_assets_dir():
    return os.path.join(get_assets_dir(), "assets")


def ensure_user_assets_dir():
    assets_dir = get_user_assets_dir()
    os.makedirs(assets_dir, exist_ok=True)
    return assets_dir


def resolve_promptshop_image_path(image_path: str) -> str:
    image_path = (image_path or "").strip()
    assets_dir = get_assets_dir()
    user_assets_dir = get_user_assets_dir()

    if not image_path or image_path == "assets/no-image.png":
        return os.path.join(assets_dir, "no-image.png")

    if image_path.startswith("http://") or image_path.startswith("https://"):
        raise ValueError("remote image is not supported")

    if image_path.startswith("assets/"):
        filename = os.path.basename(image_path)
        candidate = os.path.abspath(os.path.join(user_assets_dir, filename))
        if candidate.startswith(os.path.abspath(user_assets_dir)):
            return candidate

    candidate = os.path.abspath(os.path.join(assets_dir, image_path))
    if candidate.startswith(os.path.abspath(assets_dir)):
        return candidate

    raise ValueError("invalid image path")


def build_card_png_bytes(source_path: str, title: str, prompt: str) -> bytes:
    pnginfo = PngImagePlugin.PngInfo()
    title = str(title or "")
    prompt = str(prompt or "")

    # 互換性を考えて汎用キーと専用キーの両方に書く
    pnginfo.add_text("Title", title)
    pnginfo.add_text("Prompt", prompt)
    pnginfo.add_text("Description", prompt)
    pnginfo.add_text("promptshop_title", title)
    pnginfo.add_text("promptshop_prompt", prompt)

    output = io.BytesIO()

    if source_path and os.path.exists(source_path):
        with Image.open(source_path) as image:
            if image.mode not in ("RGB", "RGBA"):
                image = image.convert("RGBA")
            image.save(output, format="PNG", pnginfo=pnginfo)
    else:
        image = Image.new("RGBA", (512, 512), (220, 220, 220, 255))
        image.save(output, format="PNG", pnginfo=pnginfo)

    return output.getvalue()


def extract_card_png_metadata(file_obj) -> dict:
    with Image.open(file_obj) as image:
        info = image.info or {}
        title = info.get("promptshop_title") or info.get("Title") or ""
        prompt = info.get("promptshop_prompt") or info.get("Prompt") or info.get("Description") or ""
        return {
            "title": str(title or ""),
            "prompt": str(prompt or "")
        }


def on_app_started(demo, app):
    @app.post("/promptshop/save")
    async def promptshop_save(data: PromptShopData):
        ext_dir = get_ext_dir()
        json_path = os.path.join(ext_dir, "assets", "prompts.json")

        with open(json_path, "w", encoding="utf-8") as f:
            json.dump(data.dict(), f, ensure_ascii=False, indent=2)

        return {"ok": True, "path": json_path}

    @app.post("/promptshop/upload-image")
    async def promptshop_upload_image(file: UploadFile = File(...)):
        assets_dir = ensure_user_assets_dir()

        ext = os.path.splitext(file.filename)[1].lower()
        if ext not in [".png", ".jpg", ".jpeg", ".webp", ".gif"]:
            return {"ok": False, "error": "unsupported file type"}

        filename = f"{int(time.time() * 1000)}{ext}"
        file_path = os.path.join(assets_dir, filename)

        with open(file_path, "wb") as f:
            shutil.copyfileobj(file.file, f)

        return {
            "ok": True,
            "path": f"assets/{filename}"
        }
    @app.post("/promptshop/import-image-from-src")
    async def promptshop_import_image_from_src(request: Request):
        data = await request.json()
        src = data.get("src", "")

        if "/file=" not in src:
            return {"ok": False, "error": "invalid src"}

        raw_path = src.split("/file=", 1)[1].split("?", 1)[0]
        raw_path = raw_path.replace("%20", " ")

        import urllib.parse
        source_path = urllib.parse.unquote(raw_path)

        if not os.path.exists(source_path):
            return {"ok": False, "error": f"source not found: {source_path}"}

        assets_dir = ensure_user_assets_dir()

        ext = os.path.splitext(source_path)[1].lower()
        if ext not in [".png", ".jpg", ".jpeg", ".webp"]:
            ext = ".png"

        filename = f"generated_{int(time.time() * 1000)}{ext}"
        dest_path = os.path.join(assets_dir, filename)

        shutil.copy2(source_path, dest_path)

        return {
            "ok": True,
            "path": f"assets/{filename}"
        }

    @app.post("/promptshop/export-card-png")
    async def promptshop_export_card_png(data: PromptShopCardPngExport):
        try:
            source_path = resolve_promptshop_image_path(data.image)
            png_bytes = build_card_png_bytes(source_path, data.title, data.prompt)
        except Exception as err:
            return Response(content=str(err), status_code=400, media_type="text/plain")

        download_name = f"{(data.title or 'card').strip() or 'card'}.png"
        # HTTPヘッダーはlatin-1として扱われるため、日本語ファイル名をそのまま入れると
        # UnicodeEncodeErrorになる。RFC 5987形式のfilename*=UTF-8''...で渡す。
        encoded_name = urllib.parse.quote(download_name.encode("utf-8"))
        headers = {
            "Content-Disposition": f"attachment; filename=promptshop_card.png; filename*=UTF-8''{encoded_name}"
        }
        return Response(content=png_bytes, media_type="image/png", headers=headers)

    @app.post("/promptshop/read-card-png-metadata")
    async def promptshop_read_card_png_metadata(file: UploadFile = File(...)):
        filename = (file.filename or "").lower()
        if not (filename.endswith(".png") or file.content_type == "image/png"):
            return {"ok": False, "error": "png only"}

        try:
            metadata = extract_card_png_metadata(file.file)
        except Exception as err:
            return {"ok": False, "error": f"metadata read failed: {err}"}

        return {"ok": True, **metadata}

    @app.post("/promptshop/delete-image")
    async def promptshop_delete_image(request: Request):
        data = await request.json()
        image_path = data.get("path", "")

        if not image_path or image_path == "assets/no-image.png":
            return {"ok": True, "message": "skip default image"}

        if image_path.startswith("http://") or image_path.startswith("https://"):
            return {"ok": True, "message": "skip url image"}

        if not image_path.startswith("assets/"):
            return {"ok": False, "error": "not allowed path"}

        filename = os.path.basename(image_path)

        assets_dir = ensure_user_assets_dir()
        file_path = os.path.abspath(os.path.join(assets_dir, filename))
        allowed_dir = os.path.abspath(assets_dir)

        if not file_path.startswith(allowed_dir):
            return {"ok": False, "error": "invalid path"}

        if os.path.exists(file_path) and os.path.isfile(file_path):
            os.remove(file_path)

        return {"ok": True}


def on_ui_tabs():
    with gr.Blocks() as prompt_shop:
        gr.HTML('<div id="prompt-shop-root"></div>')

    return [(prompt_shop, "PromptShopNeo", "prompt_shop_tab")]


script_callbacks.on_app_started(on_app_started)
script_callbacks.on_ui_tabs(on_ui_tabs)