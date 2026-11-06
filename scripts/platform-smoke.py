"""Real-service smoke: run with the server and worker running. Uses curl and fictional fixtures."""
import json
import pathlib
import re
import subprocess
import tempfile
import time
import uuid

BASE = "http://localhost:4601"
MAIL = "http://127.0.0.1:8025"

def request(method, path, body=None, cookie=None, status=200):
    args = ["curl.exe", "-sS", "-X", method, "-w", "\n%{http_code}"]
    if not path.startswith("http"):
        args += ["-H", "Origin: http://localhost:4600"]
    if cookie:
        args += ["-b", str(cookie), "-c", str(cookie)]
    if body is not None:
        args += ["-H", "Content-Type: application/json", "--data-binary", "@-"]
    args += [path if path.startswith("http") else BASE + path]
    result = subprocess.run(args, input=json.dumps(body) if body is not None else None, text=True, encoding="utf-8", capture_output=True, check=True)
    content, code = result.stdout.rsplit("\n", 1)
    assert int(code) == status, f"{method} {path}: expected {status}, got {code}: {content[:300]}"
    return json.loads(content) if content else None

with tempfile.TemporaryDirectory(prefix="logbird-smoke-") as temporary:
    cookie = pathlib.Path(temporary) / "cookies"
    suffix = uuid.uuid4().hex[:10]
    email = f"foundation-{suffix}@example.test"
    assert request("GET", "/health")["status"] == "ok"
    request("GET", "/api/me", status=401)
    request("POST", "/api/auth/email-otp/send-verification-otp", {"email": email, "type": "sign-in"})
    messages = request("GET", MAIL + "/api/v1/messages")["messages"]
    message = next(m for m in messages if any(t["Address"] == email for t in m["To"]))
    mail = request("GET", MAIL + "/api/v1/message/" + message["ID"])
    code = re.search(r"\b(\d{6})\b", mail["Text"]).group(1)
    request("POST", "/api/auth/sign-in/email-otp", {"email": email, "otp": code}, cookie)
    me = request("GET", "/api/me", cookie=cookie)
    assert me["user"]["email"] == email
    org = request("POST", "/api/auth/organization/create", {"name": "Foundation smoke", "slug": "foundation-" + suffix}, cookie)
    request("POST", "/api/auth/organization/set-active", {"organizationId": org["id"]}, cookie)
    me = request("GET", "/api/me", cookie=cookie)
    assert me["activeOrganizationId"] == org["id"]
    created = request("POST", "/api/projects", {"name": "Foundation smoke", "retentionDays": 90}, cookie, 201)
    project = created["project"]
    assert re.fullmatch(r"lb_ingest_[A-Za-z0-9]{32}", created["ingestKey"]["secret"])
    path = "/api/projects/" + project["id"]
    listed = request("GET", path + "/keys", cookie=cookie)
    assert "secret" not in json.dumps(listed) and "hash" not in json.dumps(listed)
    assert len(listed["data"]) == 1
    key = request("POST", path + "/keys", {"name": "Smoke read key", "kind": "read"}, cookie, 201)
    assert re.fullmatch(r"lb_read_[A-Za-z0-9]{32}", key["secret"])
    request("DELETE", path + "/keys/" + key["key"]["id"], cookie=cookie, status=204)
    assert next(k for k in request("GET", path + "/keys", cookie=cookie)["data"] if k["id"] == key["key"]["id"])["revokedAt"]
    error = request("PATCH", path, {"retentionDays": 7}, cookie, 422)
    assert error["error"]["code"] == "confirmation_required"
    request("PATCH", path, {"retentionDays": 7, "confirm": "wrong"}, cookie, 422)
    request("PATCH", path, {"retentionDays": 7, "confirm": project["slug"]}, cookie)
    request("POST", path + "/keys", {"name": "", "kind": "read"}, cookie, 422)
    view = request("POST", path + "/views", {"name": "Failures", "description": None, "state": {"q": "outcome:failure"}}, cookie, 201)
    assert len(request("GET", path + "/views", cookie=cookie)["data"]) == 1
    request("DELETE", path + "/views/" + view["id"], cookie=cookie, status=204)
    # Switching active org must fence even a project in another org owned by this user.
    other = request("POST", "/api/auth/organization/create", {"name": "Other smoke workspace", "slug": "other-" + suffix}, cookie)
    request("POST", "/api/auth/organization/set-active", {"organizationId": other["id"]}, cookie)
    request("GET", path, cookie=cookie, status=404)
    request("POST", "/api/auth/organization/set-active", {"organizationId": org["id"]}, cookie)
    request("POST", "/api/auth/organization/invite-member", {"email": "invited-" + suffix + "@example.test", "role": "member"}, cookie)
    disposable = request("POST", "/api/projects", {"name": "Disposable smoke"}, cookie, 201)["project"]
    request("DELETE", "/api/projects/" + disposable["id"], cookie=cookie, status=204)
    request("GET", "/api/projects/" + disposable["id"], cookie=cookie, status=404)
    assert request("GET", "/openapi.json")["paths"]["/api/projects"]
    pathlib.Path(".tmp/smoke.json").parent.mkdir(exist_ok=True)
    pathlib.Path(".tmp/smoke.json").write_text(json.dumps({"projectId": project["id"], "messageId": message["ID"]}))
    print("PASS: health (Postgres + ClickHouse), anonymous 401, curl OTP -> Mailpit -> cookie -> /api/me")
    print("PASS: organization create/set-active, project + initial ingest key, list/create/revoke keys")
    print("PASS: retention confirmation 422 (missing/wrong) + confirmed update, invalid body 422")
    print("PASS: saved view create/list/delete, active organization fence 404, generated OpenAPI, invitation email, project delete")
    print("Fictional fixtures retained for RetentionRun readback; no session, OTP or API secret printed.")
