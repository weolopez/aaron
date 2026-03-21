/**
 * Agent execution harness with improved error handling and context management
 */

const SYSTEM_PROMPT = `You are a coding agent operating in an isomorphic JavaScript environment.

Your ONLY output is a single JavaScript code block:

\`\`\`js
// your code here
\`\`\`

The code runs inside an async function. You have access to a \`context\` object:

  context.vfs.read(path)            → string | null
  context.vfs.write(path, content)  → void
  context.vfs.list()                → string[]
  context.emit({ type, ...fields }) → void
  context.fetch(url, options)       → Promise<Response>
  context.env                       → {}  (config, feature flags)
  context.commit(message)           → Promise<string[]>  (persist dirty files)

Emit event types:
  { type: 'progress',   message: 'string' }
  { type: 'result',     value: any }
  { type: 'file_write', path: 'string' }
  { type: 'file_read',  path: 'string' }
  { type: 'done',       message: 'string' }
  { type: 'metric',     name: 'string', value: number, unit: 'string' }

Conventions:
  - Write scratch / planning work to /scratch/*
  - Write final outputs to /artifacts/*
  - Write durable memory to /memory/*
  - Your own harness code is at /harness/* — you can read and improve it
  - ALWAYS end with: context.emit({ type: 'done', message: '...' })
  - Emit progress updates for multi-step work
  - Emit metrics for measurable outcomes
  - No text outside the code block

If you encounter errors:
  - Log the error context to /scratch/error-log.txt
  - Attempt recovery by simplifying the approach
  - Always emit a done message even on failure
`;

async function runTurn(userMessage, context) {
  const startTime = Date.now();
  let lastError = null;
  let executionAttempt = 0;
  const maxAttempts = 2;

  // Enhanced context with error tracking
  const enhancedContext = {
    ...context,
    emit: (event) => {
      // Log all emissions for debugging
      if (event.type === 'progress' || event.type === 'done') {
        const timestamp = new Date().toISOString();
        const logEntry = `[${timestamp}] ${event.type}: ${event.message || JSON.stringify(event)}\n`;
        const existingLog = context.vfs.read('/scratch/execution-log.txt') || '';
        context.vfs.write('/scratch/execution-log.txt', existingLog + logEntry);
      }
      return context.emit(event);
    }
  };

  while (executionAttempt < maxAttempts) {
    executionAttempt++;
    
    try {
      context.emit({ type: 'progress', message: `Starting execution attempt ${executionAttempt}/${maxAttempts}` });

      const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMessage }
      ];

      // Add error context from previous attempt if available
      if (lastError && executionAttempt > 1) {
        messages.push({
          role: 'user', 
          content: `Previous attempt failed with error: ${lastError}. Please simplify your approach and ensure you emit a 'done' event.`
        });
      }

      const response = await context.llm.chat(messages);
      
      if (!response || !response.content) {
        throw new Error('Empty response from LLM');
      }

      // Extract and validate JavaScript code
      const codeMatch = response.content.match(/\`\`\`js\n([\s\S]*?)\n\`\`\`/);
      if (!codeMatch) {
        throw new Error('No JavaScript code block found in response');
      }

      const code = codeMatch[1];
      if (!code.trim()) {
        throw new Error('Empty code block');
      }

      // Enhanced execution with timeout and cleanup
      const executeWithTimeout = async (code, timeoutMs = 30000) => {
        return new Promise(async (resolve, reject) => {
          const timeoutId = setTimeout(() => {
            reject(new Error(`Execution timeout after ${timeoutMs}ms`));
          }, timeoutMs);

          try {
            const asyncFunction = new Function('context', `return (async function() { ${code} })();`);
            await asyncFunction(enhancedContext);
            clearTimeout(timeoutId);
            resolve();
          } catch (error) {
            clearTimeout(timeoutId);
            reject(error);
          }
        });
      };

      await executeWithTimeout(code);
      
      const executionTime = Date.now() - startTime;
      context.emit({ 
        type: 'metric', 
        name: 'execution_time', 
        value: executionTime, 
        unit: 'ms' 
      });
      
      return; // Success - exit the retry loop

    } catch (error) {
      lastError = error.message;
      
      // Log detailed error information
      const errorLog = `
Attempt ${executionAttempt} failed:
Error: ${error.message}
Stack: ${error.stack}
Time: ${new Date().toISOString()}
User Message: ${userMessage}
---
`;
      
      const existingErrorLog = context.vfs.read('/scratch/error-log.txt') || '';
      context.vfs.write('/scratch/error-log.txt', existingErrorLog + errorLog);

      context.emit({ 
        type: 'progress', 
        message: `Attempt ${executionAttempt} failed: ${error.message}` 
      });

      if (executionAttempt >= maxAttempts) {
        // Final fallback - ensure we always emit done
        context.emit({ 
          type: 'done', 
          message: `Task failed after ${maxAttempts} attempts. Last error: ${lastError}` 
        });
        return;
      }
    }
  }
}

module.exports = { runTurn, SYSTEM_PROMPT };
