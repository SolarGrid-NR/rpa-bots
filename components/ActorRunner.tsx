'use client';

import { useState, useEffect } from 'react';
import Form from '@rjsf/core';
import validator from '@rjsf/validator-ajv8';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { ActorDefinition } from '@/app/actions';
import { Loader2, Play, Terminal, Files } from 'lucide-react';
import { toast } from 'sonner';

interface ActorRunnerProps {
    actors: ActorDefinition[];
}

export default function ActorRunner({ actors }: ActorRunnerProps) {
    const [selectedActorName, setSelectedActorName] = useState<string>('');
    const [formData, setFormData] = useState<any>({});
    const [isRunning, setIsRunning] = useState(false);
    const [runResult, setRunResult] = useState<any>(null);
    const [mounted, setMounted] = useState(false);
    const [logContent, setLogContent] = useState<string>('');

    // Prevent hydration mismatch for Radix UI components
    useEffect(() => {
        setMounted(true);
    }, []);

    if (!mounted) {
        return <div className="flex items-center justify-center min-h-[50vh]"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>;
    }

    const selectedActor = actors.find(a => a.name === selectedActorName);

    const handleRun = async () => {
        if (!selectedActor) return;
        setIsRunning(true);
        setRunResult(null);
        setLogContent('');
        toast.info(`Starting actor ${selectedActor.name}...`);

        try {
            const response = await fetch('/api/run-actor', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    actorName: selectedActor.name,
                    input: formData
                })
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || 'Failed to run actor');
            }

            setRunResult(data);

            // Start polling for logs and status
            const pollInterval = setInterval(async () => {
                try {
                    // 1. Poll Logs
                    const logRes = await fetch(`/api/storage/${data.runId}/run.log?type=log`, { cache: 'no-store' });
                    if (logRes.ok) {
                        const text = await logRes.text();
                        setLogContent(text);
                    }

                    // 2. Poll Status to see if finished
                    const statusRes = await fetch(`/api/storage/${data.runId}/status.json`, { cache: 'no-store' });
                    if (statusRes.ok) {
                        const status = await statusRes.json();
                        // If we found status.json, the actor is done
                        clearInterval(pollInterval);
                        setIsRunning(false);

                        // Fetch final artifacts list
                        // Refetch the run info (or just list artifacts)
                        // For now we can refresh the log one last time
                        toast.success(`Actor finished with code ${status.exitCode}`);

                        // Optionally refresh the runResult to get new artifacts if we improved the backend result API
                        // But for now, let's at least show the updated state
                    }
                } catch (e) {
                    console.error("Polling error", e);
                }
            }, 1000);

            // Safety timeout (stop polling after 5 minutes)
            setTimeout(() => {
                clearInterval(pollInterval);
                if (isRunning) setIsRunning(false);
            }, 300000);

        } catch (error: any) {
            console.error('Run failed:', error);
            toast.error(`Run failed: ${error.message}`);
            setIsRunning(false);
        }
    };

    const copyToClipboard = (text: string) => {
        navigator.clipboard.writeText(text);
        toast.success('Copied to clipboard');
    };

    return (
        <div className="container mx-auto p-4 max-w-5xl space-y-8 animate-in fade-in duration-500">
            <div className="text-center space-y-2 mb-8">
                <h1 className="text-4xl font-bold tracking-tight bg-gradient-to-r from-blue-600 to-cyan-500 bg-clip-text text-transparent">
                    Local RPA Runner
                </h1>
                <p className="text-muted-foreground text-lg">
                    Orchestrate your Apify-compatible bots securely and locally.
                </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <Card className="shadow-lg border-t-4 border-t-primary/80">
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                            <Terminal className="w-5 h-5 text-primary" />
                            Configuration
                        </CardTitle>
                        <CardDescription>Select an actor and configure your inputs.</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-6">
                        <div className="space-y-2">
                            <Label className="text-base">Select Distributor</Label>
                            <Select onValueChange={(val) => {
                                setSelectedActorName(val);
                                setFormData({});
                                setRunResult(null);
                                setLogContent('');
                            }} value={selectedActorName}>
                                <SelectTrigger className="h-11">
                                    <SelectValue placeholder="Choose an actor..." />
                                </SelectTrigger>
                                <SelectContent>
                                    {actors.map(actor => (
                                        <SelectItem key={actor.name} value={actor.name} className="cursor-pointer">
                                            {actor.name}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>

                        {selectedActor ? (
                            <div className="space-y-6 animate-in slide-in-from-top-4 duration-300">
                                <div className="border border-border/50 p-5 rounded-lg bg-slate-50/50 dark:bg-slate-900/50">
                                    <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-4 border-b pb-2">Input Parameters</h3>
                                    <Form
                                        schema={selectedActor.schema}
                                        validator={validator}
                                        formData={formData}
                                        onChange={({ formData }) => setFormData(formData)}
                                        onSubmit={handleRun}
                                        uiSchema={{
                                            "ui:submitButtonOptions": { norender: true },
                                            "ui:rootFieldId": "rjsf"
                                        }}
                                        className="space-y-4 [&_.form-group]:space-y-2 [&_label]:font-medium [&_input]:h-10 [&_input]:rounded-md [&_input]:border-input [&_input]:bg-background [&_input]:px-3 [&_input]:py-2 [&_input]:text-sm [&_input]:ring-offset-background"
                                    >
                                        <div className="hidden"></div>
                                    </Form>
                                </div>

                                <Button
                                    onClick={handleRun}
                                    disabled={isRunning}
                                    className="w-full h-12 text-lg font-medium shadow-md transition-all hover:scale-[1.01]"
                                    size="lg"
                                >
                                    {isRunning ? (
                                        <>
                                            <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                                            Executing Actor...
                                        </>
                                    ) : (
                                        <>
                                            <Play className="mr-2 h-5 w-5 fill-current" />
                                            Run Actor
                                        </>
                                    )}
                                </Button>
                            </div>
                        ) : (
                            <div className="flex flex-col items-center justify-center p-10 text-center text-muted-foreground border-2 border-dashed rounded-lg bg-slate-50/30 dark:bg-slate-900/10">
                                <Play className="w-10 h-10 mb-2 opacity-20" />
                                <p>Select an actor to begin configuration</p>
                            </div>
                        )}
                    </CardContent>
                </Card>

                <div className="space-y-6">
                    <Card className="h-full shadow-lg flex flex-col">
                        <CardHeader>
                            <CardTitle>Execution Output</CardTitle>
                            <CardDescription>Live results and logs from your execution.</CardDescription>
                        </CardHeader>
                        <CardContent className="flex-1 min-h-[300px]">
                            {runResult ? (
                                <div className="space-y-4">
                                    {runResult.artifacts && runResult.artifacts.length > 0 && (
                                        <div className="bg-slate-50 dark:bg-slate-900/50 p-4 rounded-md border border-border/50">
                                            <h4 className="text-sm font-medium mb-3 flex items-center gap-2">
                                                <div className="w-2 h-2 rounded-full bg-green-500" />
                                                Generated Artifacts
                                            </h4>
                                            <div className="grid grid-cols-1 gap-2">
                                                {runResult.artifacts.map((artifact: any) => {
                                                    const isImage = artifact.name.toLowerCase().match(/\.(jpg|jpeg|png|gif|webp)$/);
                                                    return (
                                                        <div key={artifact.name} className="flex flex-col gap-2">
                                                            <a
                                                                href={artifact.url}
                                                                target="_blank"
                                                                rel="noopener noreferrer"
                                                                className="flex items-center justify-between p-3 bg-background hover:bg-slate-100 dark:hover:bg-slate-800 border rounded-md transition-colors group"
                                                            >
                                                                <span className="text-sm font-medium truncate flex-1">{artifact.name}</span>
                                                                <span className="text-xs text-muted-foreground group-hover:text-primary transition-colors">Download</span>
                                                            </a>
                                                            {isImage && (
                                                                <div className="rounded-md overflow-hidden border border-slate-200 mt-1">
                                                                    <img src={artifact.url} alt="Artifact Preview" className="w-full h-auto object-contain max-h-[300px]" />
                                                                </div>
                                                            )}
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    )}

                                    <div className="grid grid-cols-1 gap-4 h-full min-h-[400px]">
                                        {/* JSON Output */}
                                        <div className="flex flex-col h-full bg-slate-950 rounded-md border border-slate-800 overflow-hidden">
                                            <div className="flex items-center justify-between px-4 py-2 bg-slate-900 border-b border-slate-800">
                                                <span className="text-xs font-mono text-slate-400">JSON Output</span>
                                                <Button variant="ghost" size="icon" className="h-6 w-6 text-slate-400 hover:text-white" onClick={() => copyToClipboard(JSON.stringify(runResult, null, 2))}>
                                                    <Files className="h-3 w-3" />
                                                </Button>
                                            </div>
                                            <div className="flex-1 overflow-auto p-4 custom-scrollbar max-h-[300px]">
                                                <pre className="text-xs font-mono text-green-400">
                                                    {JSON.stringify(runResult, null, 2)}
                                                </pre>
                                            </div>
                                        </div>

                                        {/* Logs */}
                                        <div className="flex flex-col h-full bg-slate-950 rounded-md border border-slate-800 overflow-hidden">
                                            <div className="flex items-center justify-between px-4 py-2 bg-slate-900 border-b border-slate-800">
                                                <span className="text-xs font-mono text-slate-400">Execution Logs</span>
                                                <Button variant="ghost" size="icon" className="h-6 w-6 text-slate-400 hover:text-white" onClick={() => copyToClipboard(logContent)}>
                                                    <Files className="h-3 w-3" />
                                                </Button>
                                            </div>
                                            <div className="flex-1 overflow-auto p-4 custom-scrollbar max-h-[300px]">
                                                <pre className="text-xs font-mono text-blue-300 whitespace-pre-wrap">
                                                    {logContent || 'No logs available.'}
                                                </pre>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            ) : (
                                <div className="h-full flex flex-col items-center justify-center text-muted-foreground bg-slate-100/50 dark:bg-slate-900/50 rounded-md border border-dashed">
                                    <div className="p-4 rounded-full bg-background mb-4 shadow-sm">
                                        <Terminal className="w-8 h-8 opacity-40" />
                                    </div>
                                    <p>Waiting for execution...</p>
                                </div>
                            )}
                        </CardContent>
                    </Card>
                </div>
            </div>
        </div>
    );
}
