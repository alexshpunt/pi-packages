/** Redact review evidence without changing Pi's actual execution environment. */
const PRIVATE_ENV =
    /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|AUTH|^AWS_|^AZURE_|^GOOGLE_|^OPENAI_|^ANTHROPIC_|^CODEX_|^SSH_|^GIT_CONFIG|^NODE_|^BASH_ENV$|^ENV$|^DYLD_|^LD_|^JAVA_TOOL_OPTIONS$|^JDK_JAVA_OPTIONS$|^PYTHONPATH$|^PYTHONSTARTUP$|^RUBYOPT$|^PERL5OPT$|PROXY|^NO_PROXY$)/i;
export function reviewEnvironment(
    environment: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
    return Object.fromEntries(
        Object.entries(environment).filter(
            ([key, value]) => !PRIVATE_ENV.test(key) && value !== undefined,
        ),
    );
}
export function redactedEnvironmentNames(
    environment: NodeJS.ProcessEnv = {},
): string[] {
    return Object.keys(environment)
        .filter(
            (key) => PRIVATE_ENV.test(key) && environment[key] !== undefined,
        )
        .sort();
}
