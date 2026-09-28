import { describe, expect, it } from 'vitest';
import { explain } from '../src/targets/explain';
import type { Target } from '../src/targets/target';

const compose: Target = {
    id: 'c',
    kind: 'compose',
    name: 'app',
    service: 'app',
    workingDir: '/var/www',
    environment: 'local',
};
const local: Target = {
    id: 'l',
    kind: 'local',
    name: 'Local PHP',
    workingDir: '',
    environment: 'local',
};
const ssh = (port: number): Target => ({
    id: 's',
    kind: 'ssh',
    name: 'prod',
    host: 'app.example.com',
    user: 'forge',
    port,
    workingDir: '/home/forge/app',
    environment: 'production',
});
const hint = (error: string, target: Target): string =>
    explain(new Error(error), target).split('\n').slice(1).join('\n');

describe('explain', () => {
    it('suggests starting a stopped Compose service', () => {
        expect(hint('service "app" is not running', compose)).toBe(
            'Start it with: docker compose up -d app',
        );
    });

    it('asks whether Docker is running', () => {
        expect(
            hint('Cannot connect to the Docker daemon at unix:///var/run/docker.sock', compose),
        ).toBe('Is Docker running?');
    });

    it('points at the project path when Composer autoload is missing', () => {
        expect(hint('Failed opening /var/www/vendor/autoload.php', compose)).toBe(
            "Check the target's project path (/var/www) and that composer install has run.",
        );
        expect(hint('vendor/autoload.php not found', local)).toBe(
            "Check the target's project path and that composer install has run.",
        );
    });

    it('gives the exact ssh command to trust a host key, with its port', () => {
        expect(hint('Host key verification failed.', ssh(22))).toBe(
            'Connect once with ssh forge@app.example.com in a terminal to trust the host key.',
        );
        expect(hint('Host key verification failed.', ssh(2222))).toBe(
            'Connect once with ssh -p 2222 forge@app.example.com in a terminal to trust the host key.',
        );
    });

    it('explains a worker parse error as an old PHP version', () => {
        expect(
            hint(
                'PHP Parse error: syntax error, unexpected identifier "readonly" in /tmp/opentinker/worker-abc.php on line 40',
                compose,
            ),
        ).toBe('OpenTinker needs PHP 8.1 or later where your app runs.');
    });

    it('asks whether PHP or the docker/ssh command is installed', () => {
        expect(hint('spawn php ENOENT', local)).toBe('Is PHP installed and on your PATH?');
        expect(hint('spawn docker ENOENT', compose)).toBe('Is the docker/ssh command installed?');
    });

    it('passes other errors through unchanged', () => {
        expect(explain('Something else', compose)).toBe('Something else');
    });
});
