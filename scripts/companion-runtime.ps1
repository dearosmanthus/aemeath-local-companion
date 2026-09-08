function Test-CompanionRuntimePayload {
  param($Payload)
  return ($Payload.app -eq 'aemeath-local-companion' -and
    $Payload.security.policy -eq 'selectable-chat-v1' -and
    $Payload.security.credentials -eq 'session-only' -and
    $Payload.security.localTransport -eq 'loopback-only-v2')
}

function Test-CompanionRuntime {
  # Fixed local endpoint; no proxy, redirects, credentials, model or voice calls.
  $runtimeResponse = $null
  $runtimeReader = $null
  try {
    $runtimeRequest = [System.Net.HttpWebRequest]::Create('http://127.0.0.1:17860/api/runtime')
    $runtimeRequest.Proxy = $null
    $runtimeRequest.AllowAutoRedirect = $false
    $runtimeRequest.Timeout = 2000
    $runtimeRequest.ReadWriteTimeout = 2000
    $runtimeResponse = $runtimeRequest.GetResponse()
    if ([int]$runtimeResponse.StatusCode -ne 200) { return $false }
    $runtimeReader = [System.IO.StreamReader]::new($runtimeResponse.GetResponseStream())
    return (Test-CompanionRuntimePayload ($runtimeReader.ReadToEnd() | ConvertFrom-Json))
  } catch { return $false }
  finally {
    if ($runtimeReader) { $runtimeReader.Dispose() }
    if ($runtimeResponse) { $runtimeResponse.Dispose() }
  }
}
