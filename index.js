var enot = require('enot');
var _ = require('mutypes');
var eachCSV = require('each-csv');

module['exports'] = applyState;

//externs
var isObject = _['isObject'];
var has = _['has'];
var isFn = _['isFn'];
var isPlain = _['isPlain'];

var eOn = enot['on'];
var eOff = enot['off'];


//tech names
var enterCallbackName = 'before';
var leaveCallbackName = 'after';
var initCallbackName = 'init';
var changedCallbackName = 'changed';
var setterName = 'set';
var getterName = 'get';
var remainderStateName = '_';


//values keyed by target
var valuesCache = new WeakMap;

//as far properties can change it’s behaviour dynamically, we have to keep real states somewhere
var statesCache = new WeakMap;

//list of dependencies for the right init order
var depsCache = new WeakMap;

//map of callbacks active on target
var activeCallbacks = new WeakMap;

//set of native properties per target
var ignoreCache = new WeakMap;

//set of target prop setters
var settersCache = new WeakMap;


//apply state to a target
//native properties sohuld be passed as a blacklist
function applyState(target, props, ignoreProps){
	//create target private storage
	if (!valuesCache.has(target)) valuesCache.set(target, {});
	if (!statesCache.has(target)) statesCache.set(target, {});
	if (!activeCallbacks.has(target)) activeCallbacks.set(target, {});
	if (!ignoreCache.has(target)) ignoreCache.set(target, ignoreProps || {});
	if (!settersCache.has(target)) settersCache.set(target, {});

	flattenKeys(props, true);

	//calc dependencies, e.g. b depends on a = {b: {a: true}, a: {}}
	var deps = {};
	depsCache.set(target, deps);

	for (var propName in props){
		deps[propName] = deps[propName] || {};

		var prop = props[propName];
		if (isObject(prop)) {
			for (var stateName in prop){
				var innerProps = prop[stateName];
				//pass non-object inner props
				if (!isObject(innerProps)) continue;

				for (var innerPropName in innerProps){
					if (isStateTransitionName(innerPropName) || innerPropName === propName) continue;

					var innerProp = innerProps[innerPropName];

					//save parent prop as a dependency for inner prop
					(deps[innerPropName] = deps[innerPropName] || {})[propName] = true;

					//save stringy inner prop as a dependece for the prop
					if (isString(innerProp)) (deps[propName] = deps[propName] || {})[innerProp] = true;

					//stub property on target with proper type (avoid uninited calls of inner methods)
					if (!has(target, innerPropName) && !has(props, innerPropName)) {
						if (isFn(innerProp)) target[innerPropName] = noop;
					}
				}
			}
		}
	}

	//create accessors
	createProps(target, props);


	//init values
	for (var propName in deps){
		// console.log('default init', propName);
		initProp(target, propName);
	}

	return target;
}


//create accessor on target for every stateful property
//TODO: getect init fact via existing value in storage (throw away storage objects)
function createProps(target, props){
	var deps = depsCache.get(target);
	var ignoreProps = ignoreCache.get(target);

	//create prototypal values
	var initialValues = {}, initialStates = {};
	for (var propName in deps){
		if (!isObject(props[propName])){
			initialValues[propName] = props[propName];
		}
	}
	valuesCache.set(target, Object.create(initialValues));

	for (var name in deps) {
		var prop = props[name];

		//set initial property states as prototypes
		statesCache.get(target)[name] = Object.create(isObject(prop) ? prop : null);

		//set initialization lock in order to detect first set call
		lock(target, initCallbackName + name);

		//create fake setters for ignorable props
		if (ignoreProps[name]) {
			createSetter(target, name);
			continue;
		}

		//save initial value
		if (has(target, name)) {
			valuesCache.get(target)[name] = target[name];
		}

		//set accessors for all props, not the object ones only: some plain property may be dependent on other property’s state, so it has to be intercepted in getter and the stateful property inited beforehead
		Object.defineProperty(target, name, {
			get: (function(target, name){
				return function(){
					// console.group('get ', name)
					var propState = statesCache.get(target)[name];
					var value = valuesCache.get(target)[name];

					//init, if is not
					initProp(target, name);

					//getting prop value just returns it’s real value
					var getResult = callState(target, propState[getterName], value);
					if (getResult !== undefined) value = getResult;

					// console.groupEnd();
					return value;
				}
			})(target, name),
			set: createSetter(target, name)
		});
	};
}



//create & save setter on target
function createSetter(target, name){
	var setter = function(value){
		// console.group('set', name, value)
		var propState = statesCache.get(target)[name];
		var targetValues = valuesCache.get(target);

		//init, if is not
		initProp(target, name);
		var oldValue = targetValues[name];

		//1. apply setter to value
		var setResult = callState(target, propState[setterName], value, oldValue);
		if (setResult !== undefined) value = setResult;

		//FIXME: catch initial call better way
		//ignore leaving absent initial state
		if (!unlock(target, initCallbackName + name)) {
			//Ignore not changed value
			if (value === oldValue) {
				// console.groupEnd()
				return;
			}

			//leaving an old state unbinds all events of the old state
			var oldState = has(propState, oldValue) ? propState[oldValue] : propState[remainderStateName];

			if (!lock(target, leaveCallbackName + oldState)) {
				//try to enter new state (if redirect happens)
				var leaveResult = leaveState(target, oldState, value, oldValue);

				//redirect mod, if returned any but self
				if (leaveResult !== undefined && leaveResult !== value) {
					//ignore entering falsy state
					if (leaveResult === false) {
					}
					//enter new result
					else {
						target[name] = leaveResult;
					}

					// console.groupEnd()
					return unlock(target, leaveCallbackName + oldState);
				}

				unlock(target, leaveCallbackName + oldState);

				//ignore redirect
				if (targetValues[name] !== oldValue) {
					// console.groupEnd()
					return;
				}

				unapplyProps(target, oldState);
			}

		}

		//save new self value
		// targetValues[name] = value;
		applyValue(target, name, value)
		// console.log('set succeeded', name, value)
		var newStateName = has(propState, value) ? value : remainderStateName;
		if (!lock(target, name + newStateName)) {
			//new state applies new props: binds events, sets values
			var newState = propState[newStateName];

			applyProps(target, newState);

			//try to enter new state (if redirect happens)
			var enterResult = callState(target, newState, value, oldValue);

			//redirect mod, if returned any but self
			if (enterResult !== undefined && enterResult !== value) {
				//ignore entering falsy state
				if (enterResult === false) {
					target[name] = oldValue;
				}
				//enter new result
				else {
					target[name] = enterResult;
				}

				// console.groupEnd()
				return unlock(target, name + newStateName);
			}

			unlock(target, name + newStateName);
		}


		//4. call changed
		if (value !== oldValue)
			callState(target, propState[changedCallbackName], value, oldValue)

		// console.groupEnd()
	}

	//save setter
	settersCache.get(target)[name] = setter;

	return setter;
}



//property initializer
function initProp(target, name){
	var deps = depsCache.get(target);
	if (!deps[name]) return;

	var propState = statesCache.get(target)[name];
	var initValues = valuesCache.get(target);
	// console.log('init', name, 'dependent on', deps[name]);

	//mark dependency as resolved (ignore next init calls)
	var propDeps = deps[name];
	deps[name] = null;

	//init dependens things beforehead
	for (var depPropName in propDeps){
		if (propDeps[depPropName]) {
			// console.log('redirect init to', depPropName)
			initProp(target, depPropName);
		}
	}


	//call init with target initial value stored in targetValues
	var initResult = callState(target, propState[initCallbackName], initValues[name]);

	// applyValue(target, name, initResult);

	var isIgnored = ignoreCache.get(target)[name];
	if (!isIgnored)	{
		target[name] = initResult;
	} else {
		//call fake ignored setter
		settersCache.get(target)[name](initResult);
	}
}


//set value on target
function applyValue(target, name, value){
	valuesCache.get(target)[name] = value;

	// console.log('assign', name, value)
	//make sure context is kept bound to the target
	if (isFn(value)) {
		value = value.bind(target);
		activeCallbacks.get(target)[name] = value;
	}

	//NOTE: this causes get call
	eOn(target, name, value);
}


//take over properties by target
function applyProps(target, props){
	if (!props) return;

	for (var name in props){
		// console.group('apply prop', name)
		if (isStateTransitionName(name)) continue;

		var value = props[name];
		var state = statesCache.get(target)[name];

		//extendify descriptor value
		if (isObject(value)){
			for (var propName in value){
				state[propName] = value[propName]
			}
		}

		else {
			//FIXME: merge with the same condition in init
			if (!ignoreCache.get(target)[name])	{
				target[name] = value;
			} else {
				//call fake ignored setter
				settersCache.get(target)[name](value);
			}
		}
		// console.groupEnd();
	}
}

//unbind state declared props
function unapplyProps(target, props){
	if (!props) return;

	for (var name in props){
		// console.log('unbind', name)
		if (isStateTransitionName[name]) continue;

		var propValue = props[name];
		var state = statesCache.get(target)[name];
		var values = valuesCache.get(target);

		//delete extended descriptor
		if (isObject(propValue)){
			for (var propName in propValue){
				delete state[propName]
			}
		}

		else {
			//unbind fn value
			// console.log('off', name)
			if (isFn(propValue)) {
				var callbacks = activeCallbacks.get(target);
				if (callbacks[name]) {
					propValue = callbacks[name];
					callbacks[name] = null;
				}
			}
			eOff(target, name, propValue);

			//set value to root initial one
			delete values[name];
		}
	}
}


//try to enter a state property, like set/get/init/etc
function callState(target, state, a1, a2) {
	//undefined state (like no init meth)
	if (state === undefined) {
		return a1;
	}

	//init: 123
	else if (isPlain(state)) {
		return state;
	}

	//init: function(){}
	else if (isFn(state)) {
		return state.call(target, a1, a2);
	}

	else if (isObject(state)) {
		//init: {before: function(){}}
		if (isFn(state[enterCallbackName])) {
			return state[enterCallbackName].call(target, a1, a2);
		}
		//init: {before: 123}
		else {
			return state[enterCallbackName];
		}
	}

	//init: document.createElement('div')
	return state
}


//try to leave state: call after with new state name passed
function leaveState(target, state, a){
	// console.log('leave', state)
	if (!state) return a;

	if (!state[leaveCallbackName]) {
		return state[leaveCallbackName];
	}

	if (isFn(state[leaveCallbackName])) {
		return state[leaveCallbackName].call(target, a)
	}
}


function noop(){};

function isStateTransitionName(name){
	if (name === enterCallbackName || name === leaveCallbackName) return true;
}

//lock helpers
var lockCache = new WeakMap;
function lock(target, name){
	if (!lockCache.get(target)) lockCache.set(target, {});
	if (lockCache.get(target)[name]) return true;
	lockCache.get(target)[name] = true;
	return false;
}

function unlock(target, name){
	var res = false;
	if (lockCache.get(target)[name]) res = true;
	lockCache.get(target)[name] = null;
	return res;
}



//Disentangle listed keys
function flattenKeys(set, deep){
	//TODO: deal with existing set[key] - extend them?

	for(var keys in set){
		var value = set[keys];

		if (deep && isObject(value)) flattenKeys(value, deep);

		if (/,/.test(keys)){
			delete set[keys];

			eachCSV(keys, function(key){
				set[key] = value;
			});
		}
	}

	return set;
}



//make sure there’re no references to the target, so there’re no memory leaks
function unapplyState(target, props){
	//TODO
}