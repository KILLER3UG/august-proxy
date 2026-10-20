"""Opt-in LAN access — the backend's half of the switch.

August binds ``127.0.0.1`` by default. That is not an accident of the
packaging: the management API holds a brain database, a providers file with
API keys, and a set of file-writing tools, and "reachable from the local
network" is not a property a local app should acquire by accident.

The owner ruled on 2026-10-20 that LAN access is available — but **opt-in**,
off by default, with a warning. The desktop shell owns the decision (a
Settings switch) and **tells** the backend through ``AUGUST_LAN_BIND`` in the
environment, exactly the way it tells the backend which port to take. The
backend does not decide for itself and has no file of its own that could
talk it into being reachable: one switch, one owner, one place.

This module answers three questions and nothing else:

  * ``lan_enabled()``  — is the backend reachable from the network at all?
  * ``lan_origins(p)`` — which ``http://<ip>:<port>`` origins does that mean?
  * ``lan_status()``   — the whole answer, so the UI can be honest about
                         what is actually reachable instead of printing a URL
                         the user's phone cannot connect to.

Address discovery is the standard no-traffic trick: a UDP socket
"connected" to a public address picks the outbound interface's address
without sending a packet, and the resolver's own answer for the machine's
hostname covers what the socket does not (a host with several interfaces, a
machine whose default route is unusual). When neither yields an address the
result is an **empty list**: an invented address is worse than no address,
because the UI would then print a URL that answers nothing.
"""

from __future__ import annotations

import logging
import os
import socket

log = logging.getLogger(__name__)

#: The environment variable the desktop shell uses to TELL the backend that
#: LAN access is on. Anything else — unset, empty, ``0``, ``false`` — is off.
LAN_BIND_ENV = 'AUGUST_LAN_BIND'

#: The spellings that mean "on". Deliberately short: this is a boolean that
#: a shell, a compose file or an operator types, and a value nobody
#: recognises must read as OFF rather than as a surprise.
_TRUTHY = frozenset({'1', 'true', 'on', 'yes'})

#: Addresses tried for the outbound-interface trick. Connecting a UDP socket
#: sends nothing; it only asks the routing table which local address would be
#: used to reach the target. 8.8.8.8 is the classic choice because a default
#: route exists on almost every machine that has a network at all, even when
#: the packets would go nowhere.
_PROBE_TARGETS = (('8.8.8.8', 80), ('1.1.1.1', 80), ('192.0.2.1', 80))

#: The environment variable the shell uses to tell the backend WHICH host it
#: bound. The backend reports it verbatim, so the UI can say what is actually
#: true instead of guessing. The shell owns the bind address; the backend is
#: told, exactly as it is told about the LAN flag.
BIND_HOST_ENV = 'AUGUST_BIND_HOST'


def lan_enabled() -> bool:
    """True when the shell has told the backend to be reachable from the LAN.

    The backend is TOLD; it never decides. An app that both owns the switch
    and answers it has two places that can disagree, and the one that
    disagrees in the permissive direction is the one nobody notices.
    """
    return (os.environ.get(LAN_BIND_ENV) or '').strip().lower() in _TRUTHY


def _is_routable_ipv4(address: str) -> bool:
    """True for an address a phone on the same network could actually reach."""
    if not address:
        return False
    if address.startswith('127.') or address == '::1':
        return False
    if address.startswith('169.254.') or address.startswith('0.'):
        # Link-local (APIPA) and "this host on this network" — neither is a
        # usable origin for a phone.
        return False
    return True


def _outbound_interface_address() -> str | None:
    """The local address of the interface that would reach the internet.

    A UDP socket "connected" to a public address performs a route lookup and
    nothing else: no packet is sent, no DNS is resolved, and the peer never
    learns that it happened. The address the kernel picks for it is the
    machine's own address on that interface.
    """
    for host, port in _PROBE_TARGETS:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            probe.connect((host, port))
            address = probe.getsockname()[0]
            if _is_routable_ipv4(address):
                return address
        except OSError:
            # No route to that target, or the socket could not be opened.
            # The next candidate (and then the resolver) may still answer.
            continue
        finally:
            probe.close()
    return None


def _hostname_addresses() -> list[str]:
    """The addresses the resolver knows for this machine's hostname."""
    try:
        hostname = socket.gethostname()
        _name, _aliases, addresses = socket.gethostbyname_ex(hostname)
    except OSError:
        return []
    return [address for address in addresses if _is_routable_ipv4(address)]


def local_ipv4_addresses() -> list[str]:
    """This machine's non-loopback IPv4 addresses, best effort.

    Never raises and never invents: an empty list means "we could not tell",
    and the caller must treat that as "the UI cannot print a URL" rather
    than as "there is no address".
    """
    found: list[str] = []
    for address in [_outbound_interface_address(), *_hostname_addresses()]:
        if address and _is_routable_ipv4(address) and address not in found:
            found.append(address)
    return found


def lan_origins(port: int) -> list[str]:
    """The origins a phone on this network would use to reach the backend.

    ``http://<ip>:<port>`` for each non-loopback IPv4 address of this
    machine. Empty when no address could be discovered — an empty list is
    the honest answer, and the UI must show "no LAN address found" rather
    than a URL that answers nothing.
    """
    return [f'http://{address}:{port}' for address in local_ipv4_addresses()]


def lan_address() -> str | None:
    """This machine's LAN address — the one a phone would type.

    None when nothing could be discovered. The UI must then say "no LAN
    address found" rather than print a URL that answers nothing.
    """
    addresses = local_ipv4_addresses()
    return addresses[0] if addresses else None


def lan_bind_host() -> str:
    """The host the shell bound the backend to.

    The shell owns that decision (it is the one that passes ``--host`` to
    uvicorn), and it tells the backend what it did. When the variable is
    absent — a hand-started backend, not the desktop shell — the shell's own
    policy is assumed: every interface when LAN access is on, loopback
    otherwise.
    """
    host = (os.environ.get(BIND_HOST_ENV) or '').strip()
    if host:
        return host
    # Not a bind: the shell owns the bind address, and this is the value it
    # would have used. (S104 reads the literal, not the intent.)
    return '0.0.0.0' if lan_enabled() else '127.0.0.1'  # noqa: S104


def lan_status() -> dict:
    """What is reachable, in one object the UI can render without guessing.

    The field names are the phone panel's contract (it reads
    ``network.bindHost`` / ``network.lanAddress`` / ``network.lanEnabled``),
    so the panel needs no change when the backend starts answering them:

    ``bindHost``    — the address uvicorn is bound to.
    ``lanAddress``  — this machine's LAN address, or None if none was found.
    ``lanEnabled``  — whether LAN access is on.
    ``origins``     — every ``http://<ip>:<port>`` origin that answers.
    ``port``        — the port the backend is actually on.
    """
    from app.config import settings

    port = settings.port
    return {
        'bindHost': lan_bind_host(),
        'lanAddress': lan_address(),
        'lanEnabled': lan_enabled(),
        'origins': lan_origins(port),
        'port': port,
    }
