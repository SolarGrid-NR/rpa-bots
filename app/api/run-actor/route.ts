
import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import fsSync from 'fs';
import { v4 as uuidv4 } from 'uuid';

// Helper to wait for spawn
const runActorProcess = (actorPath: string, storagePath: string, env: NodeJS.ProcessEnv) => {
    return new Promise<{ code: number | null }>((resolve, reject) => {
        const logPath = path.join(storagePath, 'run.log');

        // Ensure log file exists
        fsSync.writeFileSync(logPath, '');

        const log = (msg: string) => {
            const timestamp = new Date().toISOString();
            const logLine = `[${timestamp}] [SYSTEM] ${msg}\n`;
            console.log(`[${timestamp}] [SYSTEM] ${msg}`);
            try {
                fsSync.appendFileSync(logPath, logLine);
            } catch (e) {
                console.error('Failed to write to log file:', e);
            }
        };

        log(`Spawning actor at ${actorPath}`);

        // Use shell: true for better Windows compatibility with npm
        const child = spawn('npm', ['start'], {
            cwd: actorPath,
            env: {
                ...process.env,
                ...env,
                FORCE_COLOR: '1',
                // Explicitly set default KV store ID to help Actor.getInput() find the right place
                APIFY_DEFAULT_KEY_VALUE_STORE_ID: 'default',
                // Prevent Apify from purging storage on start, which deletes our manually written INPUT.json
                APIFY_PURGE_ON_START: '0'
            },
            shell: true,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        child.stdout.on('data', (data) => {
            process.stdout.write(data);
            try {
                fsSync.appendFileSync(logPath, data);
            } catch (e) {
                // Ignore write errors to avoid crashing process
            }
        });

        child.stderr.on('data', (data) => {
            process.stderr.write(data);
            try {
                fsSync.appendFileSync(logPath, data);
            } catch (e) {
                // Ignore write errors
            }
        });

        child.on('close', (code) => {
            log(`Process exited with code ${code}`);
            try {
                fsSync.writeFileSync(
                    path.join(storagePath, 'key_value_stores', 'default', 'status.json'),
                    JSON.stringify({ exitCode: code, finishedAt: new Date().toISOString() })
                );
            } catch (e) {
                console.error('Failed to write status.json', e);
            }
            resolve({ code });
        });

        child.on('error', (err) => {
            log(`Process error: ${err.message}`);
            reject(err);
        });
    });
};

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const { actorName, input } = body;

        if (!actorName) {
            return NextResponse.json({ error: 'Actor name is required' }, { status: 400 });
        }

        const projectRoot = process.cwd();
        const actorPath = path.join(projectRoot, 'actors', actorName);

        // Check if actor exists
        try {
            await fs.access(actorPath);
        } catch {
            return NextResponse.json({ error: 'Actor not found' }, { status: 404 });
        }

        // Prepare storage
        const runId = uuidv4();
        // Use absolute path for storage to avoid confusion with cwd
        const storagePath = path.join(projectRoot, 'storage', 'runs', runId);
        const defaultKvStorePath = path.join(storagePath, 'key_value_stores', 'default');

        await fs.mkdir(defaultKvStorePath, { recursive: true });

        // Write INPUT.json
        await fs.writeFile(
            path.join(defaultKvStorePath, 'INPUT.json'),
            JSON.stringify(input, null, 2)
        );

        console.log(`Starting actor ${actorName} with runId ${runId}`);

        // Run Actor asynchronously (do NOT await)
        runActorProcess(actorPath, storagePath, {
            APIFY_LOCAL_STORAGE_DIR: storagePath,
        } as unknown as NodeJS.ProcessEnv).catch(err => {
            console.error(`Actor ${actorName} background process failed:`, err);
        });

        // Return immediately with runId
        return NextResponse.json({
            success: true,
            runId,
            message: 'Actor started successfully',
            status: 'running'
        });

    } catch (error: any) {
        console.error('Error running actor:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
