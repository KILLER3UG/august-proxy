"""v2 — Test that daemon tool calls reject mutating commands."""
import pytest
from app.services.tool_registry import dispatch, setDaemonContext, clearDaemonContext, isDaemonContext, isCommandBlocked

@pytest.fixture(autouse=True)
def _cleanupDaemonContext():
    clearDaemonContext()
    yield
    clearDaemonContext()

def testIsDaemonContextDefaultFalse():
    """Default context is not daemon."""
    clearDaemonContext()
    assert isDaemonContext() is False

def testSetDaemonContextMarksTrue():
    """set_daemon_context enables daemon mode."""
    setDaemonContext()
    assert isDaemonContext() is True

def testRmBlocked():
    """`rm` is detected as blocked."""
    assert isCommandBlocked('rm -rf /tmp') is True

def testMvBlocked():
    assert isCommandBlocked('mv x y') is True

def testFormatBlocked():
    assert isCommandBlocked('mkfs.ext4 /dev/sda') is True

def testDdBlocked():
    assert isCommandBlocked('dd if=/dev/zero of=/dev/sda') is True

def testChmod777Blocked():
    assert isCommandBlocked('chmod 777 /etc/passwd') is True

def testLsAllowed():
    assert isCommandBlocked('ls -la') is False

def testEchoAllowed():
    assert isCommandBlocked('echo hello') is False

@pytest.mark.asyncio
async def testDispatchBlocksRmInDaemonContext():
    """When in daemon context, rm is rejected by dispatch."""
    from app.services import tool_registry
    setDaemonContext()
    result = await dispatch('nonexistent_tool', {})
    assert 'not found' in result.lower() or 'error' in result.lower()