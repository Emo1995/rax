/* global PROPS, TAGID */
/**
 * Base Component class definition.
 */
// eslint-disable-next-line import/no-extraneous-dependencies
import { isQuickApp } from 'universal-env';
import Host from './host';
import { updateChildProps, removeComponentProps, setComponentProps } from './updater';
import { enqueueRender } from './enqueueRender';
import {
  RENDER,
  ON_SHOW,
  ON_HIDE,
  COMPONENT_DID_MOUNT,
  COMPONENT_DID_UPDATE,
  COMPONENT_WILL_MOUNT,
  COMPONENT_WILL_UNMOUNT,
  COMPONENT_WILL_RECEIVE_PROPS, COMPONENT_WILL_UPDATE,
} from './cycles';
import { cycles as pageCycles } from './page';
import shallowEqual, { is } from './shallowEqual';
import nextTick from './nextTick';
import { isNull, isFunction, isEmptyObj, isArray, isPlainObject } from './types';
import apiCore from './adapter/getNativeAPI';
import attachRef from './adapter/attachRef';

export default class Component {
  constructor(props) {
    this.state = {};
    this.props = props;
    this.refs = {};

    this.__dependencies = {}; // for context

    this.__mounted = false;
    this.__shouldUpdate = false;
    this._methods = {};
    this._hooks = {};
    this.hooks = [];
    this._hookID = 0;

    this._pendingStates = [];
    this._pendingCallbacks = [];
    nextTick(() => {
      // For get latest instance
      attachRef(this, this.props.bindComRef || this.props.ref);
    });
  }

  // Bind to this instance.
  setState = (partialState, callback) => {
    if (partialState != null) {
      this._pendingStates.push(partialState);
    }

    if (isFunction(callback)) {
      this._pendingCallbacks.push(callback);
    }

    enqueueRender(this);
  };

  forceUpdate = (callback) => {
    if (isFunction(callback)) {
      this._pendingCallbacks.push(callback);
    }
    this._updateComponent();
  };

  getHooks() {
    return this._hooks;
  }

  getHookID() {
    return ++this._hookID;
  }

  _cycles = {};

  /**
   * Register a lifecycle function.
   */
  _registerLifeCycle(cycle, fn) {
    const currentCycles = this._cycles[cycle] = this._cycles[cycle] || [];
    currentCycles.push(fn);
  }

  /**
   * Used in render cycle
   * @private
   */
  _updateData(data) {
    if (!this._internal) return;
    data.$ready = true;
    data[TAGID] = this.props[TAGID];
    this.__updating = true;
    this._setData(data);
  }

  _updateMethods(methods) {
    Object.assign(this._methods, methods);
  }

  _updateChildProps(tagId, props) {
    const chlidInstanceId = `${this.props[TAGID]}-${tagId}`;
    updateChildProps(this, chlidInstanceId, props);
  }

  _registerRefs(refs) {
    refs.forEach(({name, method, type, id}) => {
      if (isQuickApp) {
        nextTick(() => {
          Object.assign(method, {
            current: this._internal.$element(name)
          });
        });
      } else {
        if (type === 'component') {
          this._internal[name] = method;
          if (this._internal.selectComponent) {
            new Promise((resolve, reject) => {
              const instance = this._internal.selectComponent(`#${id}`, (res) => {
                resolve(res);
              });
              if (instance) {
                return resolve(instance);
              }
            })
              .then(instance => {
                this.refs[name] = {
                  current: instance
                };
                method(instance, true);
              });
          } else {
            this.refs[name] = method;
          }
        } else {
          const instance = apiCore.createSelectorQuery().select(`#${id}`);
          this.refs[name] = {
            current: instance
          };
          method(instance);
        }
      }
    });
  }

  _collectState() {
    const state = Object.assign({}, this.state);
    let parialState;
    while (parialState = this._pendingStates.shift()) { // eslint-disable-line
      if (isNull(parialState)) continue; // eslint-disable-line
      if (isFunction(parialState)) {
        Object.assign(state, parialState.call(this, state, this.props));
      } else {
        Object.assign(state, parialState);
      }
    }
    return state;
  }

  _readContext(context) {
    const Provider = context.Provider;
    const contextProp = Provider.contextProp;
    let contextItem = this.__dependencies[contextProp];
    if (!contextItem) {
      const readEmitter = Provider.readEmitter;
      const contextEmitter = readEmitter();
      contextItem = {
        emitter: contextEmitter,
        renderedContext: contextEmitter.value,
      };

      const contextUpdater = (newContext) => {
        if (!is(newContext, contextItem.renderedContext)) {
          this.__shouldUpdate = true;
          this._updateComponent();
        }
      };

      contextItem.emitter.on(contextUpdater);
      this._registerLifeCycle(COMPONENT_WILL_UNMOUNT, () => {
        contextItem.emitter.off(contextUpdater);
      });
      this.__dependencies[contextProp] = contextItem;
    }
    return contextItem.renderedContext = contextItem.emitter.value;
  }

  _injectContextType() {
    const contextType = this.constructor.contextType;
    if (contextType) {
      this.context = this._readContext(contextType);
    }
  }

  _mountComponent() {
    // Step 1: get state from getDerivedStateFromProps,
    // __getDerivedStateFromProps is a reference to constructor.getDerivedStateFromProps
    if (this.__getDerivedStateFromProps) {
      const getDerivedStateFromProps = this.__getDerivedStateFromProps;
      const partialState = getDerivedStateFromProps(this.props, this.state);
      if (partialState) this.state = Object.assign({}, partialState);
    }

    // Step 2: trigger will mount.
    this._trigger(COMPONENT_WILL_MOUNT);

    // Step3: trigger render.
    this._trigger(RENDER);

    // Step4: mark __mounted = true
    if (!this.__mounted) {
      this.__mounted = true;
    }
    // Step5: create prevProps and prevState reference
    this.prevProps = this.props;
    this.prevState = this.state;
  }

  _updateComponent() {
    if (!this.__mounted) return;
    // Step1: propTypes check, now skipped.
    // Step2: make props to prevProps, and trigger willReceiveProps
    const nextProps = this.nextProps || this.props; // actually this is nextProps
    const prevProps = this.props = this.prevProps || this.props;

    if (!shallowEqual(prevProps, nextProps)) {
      this._trigger(COMPONENT_WILL_RECEIVE_PROPS, nextProps);
    }

    // Step3: collect pending state
    let nextState = this._collectState();
    const prevState = this.prevState || this.state;

    // Step4: update state if defined getDerivedStateFromProps
    let stateFromProps;
    if (this.__getDerivedStateFromProps) {
      const getDerivedStateFromProps = this.__getDerivedStateFromProps;
      const partialState = getDerivedStateFromProps(nextProps, nextState);
      if (partialState) stateFromProps = Object.assign({}, partialState);
    }
    // if null, means not to update state.
    if (stateFromProps !== undefined) nextState = stateFromProps;

    // Step5: judge shouldComponentUpdate
    this.__shouldUpdate = this.__forceUpdate
      || this.shouldComponentUpdate ? this.shouldComponentUpdate(nextProps, nextState) : true;

    // Step8: trigger render
    if (this.__shouldUpdate) {
      this._trigger(COMPONENT_WILL_UPDATE, nextProps, nextState);
      // Set prev props & state before update
      this.prevProps = this.props;
      this.prevState = this.state;
      // Update propsMap
      setComponentProps(this.instanceId);
      this.props = nextProps;
      this.state = nextState;
      // Set forwardRef & prevForWardRef
      this.__prevForwardRef = this._forwardRef;
      this._forwardRef = nextProps.ref;
      this.__forceUpdate = false;
      this._trigger(RENDER);
      this._trigger(COMPONENT_DID_UPDATE, prevProps, prevState);
    }
  }

  _unmountComponent() {
    this._trigger(COMPONENT_WILL_UNMOUNT);
    // Clean up hooks
    this.hooks.forEach(hook => {
      if (isFunction(hook.destory)) hook.destory();
    });
    // Clean up page cycle callbacks
    this.__proto__.__nativeEventMap = {};
    this._internal.instance = null;
    this._internal = null;
    this.__mounted = false;
    removeComponentProps(this.instanceId);
  }

  /**
   * Trigger lifecycle with args.
   * @param cycle {String} Name of lifecycle.
   * @param args
   * @private
   */
  _trigger(cycle, ...args) {
    const pageId = this.instanceId;

    switch (cycle) {
      case COMPONENT_WILL_MOUNT:
      case COMPONENT_DID_MOUNT:
      case COMPONENT_WILL_RECEIVE_PROPS:
      case COMPONENT_WILL_UPDATE:
      case COMPONENT_DID_UPDATE:
      case COMPONENT_WILL_UNMOUNT:
      case ON_SHOW:
      case ON_HIDE:
        if (isFunction(this[cycle])) this[cycle](...args);
        if (this._cycles.hasOwnProperty(cycle)) {
          this._cycles[cycle].forEach(fn => fn(...args));
        }
        if (pageCycles[pageId] && pageCycles[pageId][cycle]) {
          pageCycles[pageId][cycle].forEach(fn => fn(...args));
        }
        break;

      case RENDER:
        if (!isFunction(this.render)) throw new Error('It seems component have no render method.');
        Host.current = this;
        this._hookID = 0;
        const nextProps = args[0] || this.props;
        const nextState = args[1] || this.state;

        this._injectContextType();

        this.render(this.props = nextProps, this.state = nextState);
        break;
    }
  }

  /**
   * Internal set data method
   * @param data {Object}
   * */
  _setData(data) {
    const setDataTask = [];
    let $ready = false;
    // In alibaba miniapp can use $spliceData optimize long list
    if (this._internal.$spliceData) {
      const currentData = this._internal.data;
      // Use $spliceData update
      const arrayData = {};
      // Use setData update
      const normalData = {};
      for (let key in data) {
        if (Array.isArray(data[key]) && diffArray(currentData[key], data[key])) {
          arrayData[key] = [currentData[key].length, 0].concat(data[key].slice(currentData[key].length));
        } else {
          if (diffData(currentData[key], data[key])) {
            if (isPlainObject(data[key])) {
              normalData[key] = Object.assign({}, currentData[key], data[key]);
            } else {
              normalData[key] = data[key];
            }
          }
        }
      }
      if (!isEmptyObj(normalData)) {
        $ready = normalData.$ready;
        setDataTask.push(callback => {
          this._internal.setData(normalData, callback);
        });
      }
      if (!isEmptyObj(arrayData)) {
        setDataTask.push(callback => {
          this._internal.$spliceData(arrayData, callback);
        });
      }
    } else if (isQuickApp) {
      setDataTask.push(callback => {
        for (let key in data) {
          if (key === '$ready') {
            // Only this._interanal.$ready !== data.ready, it will trigger componentDidMount
            $ready = this._internal.$ready !== data.ready;
          }
          if (!(key in this._internal)) {
            this._internal.$set(key, data[key]);
          } else if (diffData(this._internal, data)) {
            this._internal[key] = data[key];
          }
        }
        nextTick(callback);
      });
    } else {
      const normalData = {};
      for (let key in data) {
        if (diffData(this._internal.data[key], data[key])) {
          normalData[key] = data[key];
        }
      }
      if (!isEmptyObj(normalData)) {
        setDataTask.push(callback => {
          $ready = normalData.$ready;
          this._internal.setData(normalData, callback);
        });
      }
    }

    if (setDataTask.length > 0) {
      const $batchedUpdates = this._internal.$batchedUpdates || (callback => callback());

      $batchedUpdates(() => {
        const setDataPromiseTask = setDataTask.map(invokeTask => {
          return new Promise(resolve => {
            invokeTask(resolve);
          });
        });
        Promise.all(setDataPromiseTask).then(() => {
          if ($ready) {
            // trigger did mount
            this._trigger(COMPONENT_DID_MOUNT);
          }
          triggerCallbacks(this._pendingCallbacks);
        });
      });
    } else {
      triggerCallbacks(this._pendingCallbacks);
    }
  }
}

function triggerCallbacks(callbacks) {
  let callback;
  while (callback = callbacks.pop()) {
    callback();
  }
}

function diffArray(prev, next) {
  if (!isArray(prev)) return false;
  // Only concern about list append case
  if (next.length === 0) return false;
  if (prev.length === 0) return true;
  return next.slice(0, prev.length).every((val, index) => prev[index] === val);
}

function diffData(prevData, nextData) {
  const prevType = typeof prevData;
  const nextType = typeof nextData;
  if (prevType !== nextType) return true;
  if (prevType === 'object' && !isNull(prevData) && !isNull(nextData)) {
    return !shallowEqual(prevData, nextData);
  } else {
    return prevData !== nextData;
  }
}
