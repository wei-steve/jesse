import base64
from hashlib import sha256

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from jesse.controllers import review_controller
from jesse.services import auth

PASSWORD = 'review-screenshot-password'
HEADERS = {'Authorization': sha256(PASSWORD.encode('utf-8')).hexdigest()}
# Only the signature is validated by the endpoint, so a fake body is enough.
PNG = review_controller.PNG_SIGNATURE + b'fake-png-body'


@pytest.fixture
def project(tmp_path, monkeypatch):
    """A project directory: the endpoint writes relative to the cwd of `jesse run`."""
    monkeypatch.chdir(tmp_path)
    return tmp_path


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setitem(auth.ENV_VALUES, 'PASSWORD', PASSWORD)
    app = FastAPI()

    @app.exception_handler(auth.InvalidAuthError)
    async def invalid_auth_handler(_request, _exc):
        return auth.unauthorized_response()

    app.include_router(review_controller.router)
    return TestClient(app)


def body(image=PNG, **overrides):
    payload = {'image': base64.b64encode(image).decode('ascii')}
    payload.update(overrides)
    return payload


def post(client, **overrides):
    return client.post('/review/screenshot', json=body(**overrides), headers=HEADERS)


def test_endpoint_requires_auth(client, project):
    assert client.post('/review/screenshot', json=body()).status_code == 401


def test_saves_png_latest_copy_and_note(client, project):
    response = post(client, label='finder-3m', note='  看这里  ')
    assert response.status_code == 200
    data = response.json()
    folder = project / 'storage' / 'screenshots'
    path = folder / data['file']
    assert data['file'].endswith('-finder-3m.png')
    assert path.read_bytes() == PNG
    assert data['path'] == str(path)
    # latest.png always holds the most recent snapshot, so Claude can be told "look at the newest one".
    assert (folder / 'latest.png').read_bytes() == PNG
    assert path.with_suffix('.txt').read_text(encoding='utf-8') == '看这里'


def test_empty_note_writes_no_text_file(client, project):
    data = post(client, label='review-all').json()
    assert not (project / 'storage' / 'screenshots' / data['file']).with_suffix('.txt').exists()


def test_rejects_bytes_that_are_not_png(client, project):
    response = post(client, image=b'GIF89a not a png')
    assert response.status_code == 400
    assert 'PNG' in response.json()['error']
    assert not (project / 'storage' / 'screenshots').exists()


def test_rejects_invalid_base64(client, project):
    response = client.post('/review/screenshot', json={'image': '@@@not base64@@@'}, headers=HEADERS)
    assert response.status_code == 400


def test_label_keeps_only_safe_characters(client, project):
    data = post(client, label='../../evil label/../x').json()
    name = data['file']
    # `20261112-153045-evil-label----x.png`: no path separators and no leading dots.
    assert name.endswith('-evil-label----x.png')
    assert '/' not in name and '\\' not in name and '..' not in name
    assert (project / 'storage' / 'screenshots' / name).exists()


def test_label_is_truncated_and_defaults(client, project):
    assert post(client, label='a' * 80).json()['file'].count('a') == 40
    assert post(client, label=None).json()['file'].endswith('-screenshot.png')


def test_same_second_and_label_get_a_suffix(client, project):
    first = post(client, label='finder-all').json()['file']
    second = post(client, label='finder-all').json()['file']
    folder = project / 'storage' / 'screenshots'
    assert first.endswith('-finder-all.png')
    assert second.endswith('-finder-all-2.png')
    assert first != second
    # Both files are kept; latest.png is not counted as a third snapshot.
    assert sorted([first, second]) == sorted(path.name for path in folder.iterdir() if path.name != 'latest.png')


def test_rejects_oversized_body_before_decoding(client, project):
    # 4/3 of MAX_BYTES is the base64 size of a body at the limit; one more chunk trips the guard.
    oversized = 'A' * ((review_controller.MAX_BYTES // 3 + 1) * 4 + 4)
    response = client.post('/review/screenshot', json={'image': oversized}, headers=HEADERS)
    assert response.status_code == 413
