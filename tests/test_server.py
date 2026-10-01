# SPDX-License-Identifier: GPL-3.0-only
# This file is part of Crypt Sound. See LICENSE for terms; provided without warranty.
import numpy as np
import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
from crypt_sound.server import create_app
from crypt_sound.dsp import Scrambler, RATE


def test_origin_and_token():
    client = TestClient(create_app('token'))
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect('/stream', headers={'origin':'https://example.com'}):
            pass
    with client.websocket_connect('/stream', headers={'origin':'http://127.0.0.1:8765'}) as ws:
        ws.send_json({'token':'bad', 'key':'abc'})
        with pytest.raises(WebSocketDisconnect):
            ws.receive_json()


def test_websocket_decodes():
    client = TestClient(create_app('token'))
    assert client.get('/').status_code == 200
    packet = Scrambler('abc').encode(np.zeros((RATE, 2), np.float32))
    with client.websocket_connect('/stream', headers={'origin':'http://127.0.0.1:8765'}) as ws:
        ws.send_json({'token':'token', 'key':'abc'})
        assert ws.receive_json()['ready']
        for offset in range(0, RATE, 4096):
            ws.send_bytes(packet[offset:offset+4096].tobytes())
            if offset + 4096 >= RATE:
                assert len(ws.receive_bytes()) == RATE*2*4
            update = ws.receive_json()
        assert update['packets'] == 1
