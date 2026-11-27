<#
.SYNOPSIS
Runs the shared CLI protocol fixtures against the actual PowerShell consumer.
#>
[CmdletBinding()]
param([string]$EvidencePath)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot '../distribution/DistributionTools.psm1') -Force
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$fixtures=Get-Content -LiteralPath (Join-Path $repo 'test/cli-protocol-cases.json') -Raw|ConvertFrom-Json -AsHashtable
$results=[Collections.Generic.List[object]]::new()
function Render-Lines($Lines,$Case) {
    $rendered=foreach ($line in $Lines) {
        if ($line -in @('@success','@error')) {
            $ok=$line -eq '@success'
            $e=@{v=5;ok=$ok;operation=$Case.operation;revision=1;database_instance_id=('a'*64);database_epoch=('b'*64);more=$false;next=@()}
            if ($ok) { $e.data=@{reference='public:opaque-handoff-ref'} }
            else { $e.error=@{code='revision_conflict';message='test';action='Read again'} }
            if ($Case.Contains('set')) { foreach ($key in $Case.set.Keys) { $e[$key]=$Case.set[$key] } }
            if ($Case.Contains('omit')) { foreach ($key in $Case.omit) { $e.Remove($key) } }
            $e|ConvertTo-Json -Depth 32 -Compress
        } else { $line }
    }
    $rendered -join "`n"
}
foreach ($c in $fixtures.cases) {
    try {
        $result=[pscustomobject]@{ExitCode=$c.exitCode;Stdout=(Render-Lines $c.stdout $c);Stderr=(Render-Lines $c.stderr $c);Dispatched=$true}
        $actual=Read-CliEnvelope $result $c.operation $c.args ($c.effect -eq 'record_write')
        if ($actual.Kind -cne $c.expect.kind) { throw "Kind $($actual.Kind), expected $($c.expect.kind)" }
        if ($c.expect.Contains('code') -and $actual.Code -cne $c.expect.code) { throw "Code $($actual.Code), expected $($c.expect.code)" }
        if ($c.expect.Contains('mayHaveCommitted') -and $actual.MayHaveCommitted -ne $c.expect.mayHaveCommitted) { throw 'Write certainty differs.' }
        if ($c.expect.Contains('reference') -and $actual.Envelope.data.reference -cne $c.expect.reference) { throw 'Public handoff reference was lost.' }
        $results.Add([pscustomobject]@{name=$c.id;status='pass'})
    } catch { $results.Add([pscustomobject]@{name=$c.id;status='fail';error=$_.Exception.Message}) }
}
# Init is an external write; shared record-write fixtures alone cannot prove its classification.
foreach ($c in @(@{name='init_internal_error_unknown';exit=1;code='internal_error';write=$true;kind='transport_error';uncertain=$true},
    @{name='init_typed_rejection_definite';exit=2;code='invalid_input';write=$true;kind='error';uncertain=$false},
    @{name='read_internal_error_no_write';exit=1;code='internal_error';write=$false;kind='error';uncertain=$false})) {
    try {
        $e=@{v=5;ok=$false;operation='init';revision=$null;database_instance_id=$null;database_epoch=$null;more=$false;next=@();error=@{code=$c.code;message='fixture';action='Preserve the exact request and inspect current state.'}}
        $raw=$e|ConvertTo-Json -Depth 6 -Compress
        $r=Read-CliEnvelope ([pscustomobject]@{ExitCode=$c.exit;Stdout='';Stderr=$raw;Dispatched=$true}) 'init' @('init') $c.write
        if ($r.Kind -cne $c.kind -or $r.MayHaveCommitted -ne $c.uncertain -or $r.Envelope.error.action -cne $e.error.action) { throw 'Init/read outcome or original guidance was lost.' }
        $results.Add([pscustomobject]@{name=$c.name;status='pass'})
    } catch { $results.Add([pscustomobject]@{name=$c.name;status='fail';error=$_.Exception.Message}) }
}
$report=[pscustomobject]@{fixture_count=$fixtures.cases.Count;fixture_sha256=(Get-FileHash -LiteralPath (Join-Path $repo 'test/cli-protocol-cases.json')).Hash.ToLowerInvariant();cases=$results.ToArray();pass=@($results|Where-Object status -eq pass).Count;fail=@($results|Where-Object status -eq fail).Count}
$json=$report|ConvertTo-Json -Depth 8
if ($EvidencePath) { [IO.File]::WriteAllText([IO.Path]::GetFullPath($EvidencePath),$json,[Text.UTF8Encoding]::new($false)) }
$json
if ($report.fail) { exit 1 }
