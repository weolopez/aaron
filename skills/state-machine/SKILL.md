---
name: state-machine
description: Design and implement finite state machines with states, transitions, guards, actions, hierarchical states, and event-driven patterns
---

# State Machine Design & Implementation

## Approach

State machines provide a structured way to manage complex application logic by explicitly defining states, transitions between states, and the actions/guards that control those transitions. This creates predictable, testable, and maintainable code for workflows, UI state, game logic, protocol handlers, and more.

### Core Concepts

1. **States**: Distinct modes or conditions the system can be in
2. **Events**: Triggers that cause state transitions
3. **Transitions**: Movements from one state to another based on events
4. **Guards**: Conditions that must be true for a transition to occur
5. **Actions**: Side effects that execute on entry/exit or during transitions
6. **Context**: Data carried throughout the state machine lifecycle
7. **Hierarchical States**: Parent-child state relationships for complex workflows

## Implementation Templates

### Basic State Machine

```js
// Simple state machine factory
const createStateMachine = (initialState, config) => {
  let currentState = initialState;
  let context = config.context || {};

  return {
    getState: () => currentState,
    getContext: () => context,
    send: (event, payload = {}) => {
      const stateConfig = config.states[currentState];
      if (!stateConfig) return false;

      const transition = stateConfig.on?.[event];
      if (!transition) return false;

      // Check guard condition
      if (transition.guard && !transition.guard(context, payload)) {
        return false;
      }

      // Execute exit action from current state
      stateConfig.onExit?.(context, payload);

      // Update context if provided
      if (transition.updateContext) {
        context = { ...context, ...transition.updateContext(context, payload) };
      }

      // Change state
      currentState = transition.target;

      // Execute entry action for new state
      const newStateConfig = config.states[currentState];
      newStateConfig.onEntry?.(context, payload);

      return true;
    }
  };
};

// Usage example
const trafficLight = createStateMachine('red', {
  context: { duration: 30 },
  states: {
    red: {
      onEntry: (ctx) => console.log('🔴 Red light'),
      onExit: (ctx) => console.log('Leaving red'),
      on: {
        TIMER: {
          target: 'green',
          guard: (ctx) => ctx.duration > 0
        }
      }
    },
    green: {
      onEntry: (ctx) => console.log('🟢 Green light'),
      on: {
        TIMER: { target: 'yellow' }
      }
    },
    yellow: {
      onEntry: (ctx) => console.log('🟡 Yellow light'),
      on: {
        TIMER: { target: 'red' }
      }
    }
  }
});
```

### Hierarchical State Machine

```js
// State machine with nested/composite states
const createHierarchicalSM = (initialState, config) => {
  let currentState = initialState;
  let context = config.context || {};

  const getStateConfig = (statePath) => {
    const parts = statePath.split('.');
    let config = currentState;
    for (const part of parts) {
      config = config?.[part];
    }
    return config;
  };

  return {
    getState: () => currentState,
    send: (event, payload = {}) => {
      const stateConfig = config.states[currentState];
      let transition = stateConfig?.on?.[event];

      // Check local state first, then parent states
      if (!transition && stateConfig?.parent) {
        const parentConfig = config.states[stateConfig.parent];
        transition = parentConfig?.on?.[event];
      }

      if (!transition) return false;
      if (transition.guard && !transition.guard(context, payload)) return false;

      stateConfig?.onExit?.(context);
      if (transition.updateContext) {
        context = { ...context, ...transition.updateContext(context, payload) };
      }

      currentState = transition.target;
      config.states[currentState]?.onEntry?.(context);
      return true;
    }
  };
};
```

### State Machine with History

```js
// Remember previous states for back/undo functionality
const createStateMachineWithHistory = (initialState, config) => {
  let currentState = initialState;
  let history = [initialState];
  let historyIndex = 0;

  const base = createStateMachine(initialState, config);

  return {
    ...base,
    send: (event, payload) => {
      if (base.send(event, payload)) {
        const newState = base.getState();
        history = history.slice(0, historyIndex + 1);
        history.push(newState);
        historyIndex++;
        return true;
      }
      return false;
    },
    undo: () => {
      if (historyIndex > 0) {
        historyIndex--;
        currentState = history[historyIndex];
        return true;
      }
      return false;
    },
    redo: () => {
      if (historyIndex < history.length - 1) {
        historyIndex++;
        currentState = history[historyIndex];
        return true;
      }
      return false;
    },
    getHistory: () => history
  };
};
```

### Async Transitions & Delayed Events

```js
// Handle async operations and timed transitions
const createAsyncStateMachine = (initialState, config) => {
  let currentState = initialState;
  let context = config.context || {};
  const timers = {};

  const base = createStateMachine(initialState, config);

  return {
    ...base,
    send: (event, payload) => {
      const transition = config.states[currentState]?.on?.[event];
      
      if (transition?.async) {
        // Execute async operation
        transition.async(context, payload)
          .then((result) => {
            context = { ...context, ...result };
            currentState = transition.target;
            config.states[currentState]?.onEntry?.(context);
          })
          .catch((error) => {
            if (transition.onError) {
              transition.onError(error, context);
            }
          });
        return true;
      }

      return base.send(event, payload);
    },
    after: (delay, event) => {
      const timerId = setTimeout(() => {
        this.send(event);
      }, delay);
      timers[event] = timerId;
    },
    cancel: (event) => {
      clearTimeout(timers[event]);
      delete timers[event];
    }
  };
};
```

## Common Patterns

### Workflow/Process State Machine
```js
const orderWorkflow = createStateMachine('pending', {
  context: { orderId: '', items: [], total: 0 },
  states: {
    pending: {
      on: {
        CHECKOUT: { target: 'processing', guard: (ctx) => ctx.items.length > 0 }
      }
    },
    processing: {
      onEntry: (ctx) => console.log('Processing order', ctx.orderId),
      on: {
        PAYMENT_SUCCESS: { target: 'shipped' },
        PAYMENT_FAILED: { target: 'pending' }
      }
    },
    shipped: {
      onEntry: (ctx) => console.log('Order shipped'),
      on: {
        DELIVERED: { target: 'completed' }
      }
    },
    completed: {
      onEntry: (ctx) => console.log('Order completed'),
      on: {
        RETURN: { target: 'returned' }
      }
    }
  }
});
```

### Authentication State Machine
```js
const authSM = createStateMachine('unauthenticated', {
  context: { user: null, token: null, error: null },
  states: {
    unauthenticated: {
      on: {
        LOGIN: { target: 'authenticating' }
      }
    },
    authenticating: {
      onEntry: (ctx) => console.log('Authenticating...'),
      on: {
        SUCCESS: {
          target: 'authenticated',
          updateContext: (ctx, payload) => ({
            user: payload.user,
            token: payload.token
          })
        },
        FAILURE: {
          target: 'unauthenticated',
          updateContext: (ctx, payload) => ({ error: payload.error })
        }
      }
    },
    authenticated: {
      on: {
        LOGOUT: { target: 'unauthenticated' }
      }
    }
  }
});
```

## Testing State Machines

```js
// Test suite pattern
const testSM = (sm, transitions) => {
  const results = [];
  
  for (const { event, expectedState, payload } of transitions) {
    const success = sm.send(event, payload);
    const actualState = sm.getState();
    const passed = actualState === expectedState && success;
    
    results.push({
      event,
      expectedState,
      actualState,
      passed
    });
  }
  
  return results;
};

// Usage
const results = testSM(trafficLight, [
  { event: 'TIMER', expectedState: 'green' },
  { event: 'TIMER', expectedState: 'yellow' },
  { event: 'TIMER', expectedState: 'red' }
]);
```

## Checklist

- [ ] Define all possible states in the system
- [ ] List all events that can occur
- [ ] Map transitions: which events move between which states
- [ ] Identify guards (conditions blocking transitions)
- [ ] Define actions (onEntry, onExit, during transition)
- [ ] Determine context/data structure needed
- [ ] Identify if states are hierarchical (parent-child)
- [ ] Plan async operations (API calls, timers)
- [ ] Create state diagram or table visualization
- [ ] Write comprehensive tests for all transitions
- [ ] Test edge cases (invalid transitions, guard failures)
- [ ] Document state purpose and transition triggers
- [ ] Consider error states and recovery paths
- [ ] Plan state machine initialization and cleanup
- [ ] Test context updates across transitions
