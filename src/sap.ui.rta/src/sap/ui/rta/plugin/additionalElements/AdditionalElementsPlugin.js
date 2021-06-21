/*!
 * ${copyright}
 */

sap.ui.define([
	"sap/base/util/restricted/_difference",
	"sap/base/util/merge",
	"sap/base/util/each",
	"sap/base/Log",
	"sap/ui/core/util/reflection/JsControlTreeModifier",
	"sap/ui/core/IconPool",
	"sap/ui/dt/ElementUtil",
	"sap/ui/dt/OverlayRegistry",
	"sap/ui/dt/Util",
	"sap/ui/fl/apply/api/DelegateMediatorAPI",
	"sap/ui/fl/write/api/FieldExtensibility",
	"sap/ui/fl/Utils",
	"sap/ui/rta/plugin/Plugin",
	"sap/ui/rta/Utils"
], function(
	difference,
	merge,
	each,
	Log,
	JsControlTreeModifier,
	IconPool,
	ElementUtil,
	OverlayRegistry,
	DtUtils,
	DelegateMediatorAPI,
	FieldExtensibility,
	FlUtils,
	Plugin,
	Utils
) {
	"use strict";

	function _getParents(bSibling, oOverlay, oPlugin) {
		var oParentOverlay;
		var oResponsibleElementOverlay = oOverlay;
		if (oPlugin) {
			var bResponsibleElementAvailable = ["add.delegate", "reveal", "add.custom"].some(function(vActionName) {
				return oPlugin.isResponsibleElementActionAvailable(oOverlay, vActionName);
			});
			if (bResponsibleElementAvailable) {
				oResponsibleElementOverlay = oPlugin.getResponsibleElementOverlay(oOverlay);
			}
		}
		var oRelevantContainer = oResponsibleElementOverlay.getRelevantContainer(!bSibling);
		var oRelevantContainerOverlay = OverlayRegistry.getOverlay(oRelevantContainer);
		if (bSibling) {
			oParentOverlay = oResponsibleElementOverlay.getParentElementOverlay();
		} else {
			oParentOverlay = oResponsibleElementOverlay;
		}
		return {
			responsibleElementOverlay: oResponsibleElementOverlay,
			relevantContainerOverlay: oRelevantContainerOverlay,
			parentOverlay: oParentOverlay,
			relevantContainer: oRelevantContainer,
			parent: oParentOverlay && oParentOverlay.getElement() //root overlay has no parent
		};
	}

	function _defaultGetAggregationName(oParent, oChild) {
		return oChild.sParentAggregationName;
	}

	function _getInvisibleElements (oParentOverlay, sAggregationName) {
		var oParentElement = oParentOverlay.getElement();
		if (!oParentElement) {
			return [];
		}

		var aInvisibleElements = ElementUtil.getAggregation(oParentElement, sAggregationName).filter(function(oControl) {
			var oOverlay = OverlayRegistry.getOverlay(oControl);

			if (!this.hasStableId(oOverlay)) {
				return false;
			}

			var oRelevantContainer = oParentOverlay.getRelevantContainer(true);
			var oRelevantContainerOverlay = OverlayRegistry.getOverlay(oRelevantContainer);
			var oOverlayToCheck = oParentOverlay;
			var bAnyParentInvisible = false;
			// check all the parents until the relevantContainerOverlay for invisibility.
			do {
				bAnyParentInvisible = !oOverlayToCheck.getElementVisibility();
				if (bAnyParentInvisible) {
					break;
				}
				if (oOverlayToCheck === oRelevantContainerOverlay) {
					break;
				} else {
					oOverlayToCheck = oOverlayToCheck.getParentElementOverlay();
				}
			} while (oOverlayToCheck);

			if (bAnyParentInvisible) {
				return true;
			}

			return oOverlay.getElementVisibility() === false;
		}, this);

		return aInvisibleElements;
	}

	/**
	 * Get design time metadata, if you don't care about the specific actions currently available
	 * @param {Map} mActions - actions object
	 * @returns {sap.ui.dt.ElementDesignTimeMetadata} design time metadata
	 */
	function _getDTMetadataFromActions (mActions) {
		return (mActions["addViaDelegate"] && mActions["addViaDelegate"].designTimeMetadata)
			|| (mActions["addViaCustom"] && mActions["addViaCustom"].designTimeMetadata);
	}

	var SINGULAR = true;
	var PLURAL = false;
	function _getText(sRtaTextKey, mActions, oParentElement, bSingular, sControlName) {
		var aNames = [];
		var mControlType;
		var sControlType;
		var sAggregationName = mActions.aggregation;

		if (mActions.addViaCustom || mActions.addViaDelegate) {
			var oDesignTimeMetadata = _getDTMetadataFromActions(mActions);
			mControlType = oDesignTimeMetadata.getAggregationDescription(sAggregationName, oParentElement);
			if (mControlType) {
				sControlType = bSingular ? mControlType.singular : mControlType.plural;
				aNames.push(sControlType);
			}
		}
		if (mActions.reveal) {
			mActions.reveal.controlTypeNames.forEach(function(mControlType) {
				sControlType = bSingular ? mControlType.singular : mControlType.plural;
				aNames.push(sControlType);
			});
		}
		var aNonDuplicateNames = aNames.reduce(function(_aNames, sName) {
			if (_aNames.indexOf(sName) === -1) {
				_aNames.push(sName);
			}
			return _aNames;
		}, []);


		var oTextResources = sap.ui.getCore().getLibraryResourceBundle("sap.ui.rta");

		if (aNonDuplicateNames.length === 1) {
			sControlType = aNonDuplicateNames[0];
		} else if (sControlName) {
			sControlType = sControlName;
		} else {
			sControlType = oTextResources.getText("MULTIPLE_CONTROL_NAME");
		}
		return oTextResources.getText(sRtaTextKey, [sControlType]);
	}

	function _getRevealDataFromActions(mActions, oRevealedElement) {
		var mRevealData;
		mActions.reveal.elements.some(function(mElement) {
			if (mElement.element.getId() === oRevealedElement.getId()) {
				mRevealData = mElement;
				return false;
			}
		});

		return mRevealData;
	}

	function _isThereAnAggregationActionForSameAggregation (mActions, mParents) {
		var sResponsibleElementsParentAggregation = mParents.responsibleElementOverlay.getParentAggregationOverlay().getAggregationName();
		return Object.keys(mActions).some(function(sAggregationName) {
			return sAggregationName === sResponsibleElementsParentAggregation;
		});
	}

	function _isValidAction(oCheckElementOverlay, mParents, mAction, oPlugin) {
		var bValidAction = mAction.changeType && oPlugin.hasStableId(oCheckElementOverlay);
		if (bValidAction && oCheckElementOverlay !== mParents.relevantContainerOverlay) {
			//relevant container is needed for some changes, so it better has a stable ID
			bValidAction = oPlugin.hasStableId(mParents.relevantContainerOverlay);
		}
		return bValidAction;
	}

	function _filterValidAddPropertyActions(aActions, mParents, oPlugin, aDefaultDelegateLibraries) {
		return aActions.reduce(function (oPreviousActionsPromise, mAction) {
			return oPreviousActionsPromise.then(function (aFilteredActions) {
				var oCheckElement = mAction.changeOnRelevantContainer ? mParents.relevantContainer : mParents.parent;
				var oCheckElementOverlay = OverlayRegistry.getOverlay(oCheckElement);
				var bValidAction = _isValidAction(oCheckElementOverlay, mParents, mAction, oPlugin);
				if (bValidAction) {
					mAction.element = oCheckElement;
					return DelegateMediatorAPI.getDelegateForControl({
						control: mParents.relevantContainer, //delegate will always be added on the relevant container
						modifier: JsControlTreeModifier,
						supportsDefault: mAction.supportsDefaultDelegate
					})
						.then(function(mDelegateInfo) {
							if (mDelegateInfo && mDelegateInfo.names && mDelegateInfo.names.length) {
								var aRequiredLibraries = DelegateMediatorAPI.getRequiredLibrariesForDefaultDelegate({
									delegateName: mDelegateInfo.names,
									control: mParents.relevantContainer
								});

								// Check if all required libraries were successfully loaded
								if (
									difference(
										aRequiredLibraries,
										aDefaultDelegateLibraries.filter(Boolean)
									).length === 0
								) {
									mAction.delegateInfo = mDelegateInfo;
									aFilteredActions.push(mAction);
								}
							}
							return aFilteredActions;
						});
				}
				return aFilteredActions;
			});
		}, Promise.resolve([]));
	}

	function _getAddViaDelegateActionData(mAction, oDesignTimeMetadata) {
		return this.hasChangeHandler(mAction.changeType, mAction.element)
			.then(function (bHasChangeHandler) {
				if (bHasChangeHandler) {
					return {
						aggregationName: mAction.aggregation,
						addPropertyActionData: {
							designTimeMetadata: oDesignTimeMetadata,
							action: mAction,
							delegateInfo: {
								payload: mAction.delegateInfo.payload || {},
								delegate: mAction.delegateInfo.instance,
								modelType: mAction.delegateInfo.modelType,
								requiredLibraries: mAction.delegateInfo.requiredLibraries
							}
						}
					};
				}
			});
	}

	function _areLibDependenciesMissing(oComponent, mRequiredLibraries) {
		var mAppsLibDependencies = oComponent.getManifestEntry("/sap.ui5/dependencies/libs");
		return Object.keys(mRequiredLibraries).some(function(sRequiredLib) {
			return !mAppsLibDependencies[sRequiredLib];
		});
	}

	function _loadKnownDefaultDelegateLibraries() {
		var aLoadLibraryPromises = [];
		var aRequiredLibraries = DelegateMediatorAPI.getKnownDefaultDelegateLibraries();
		aRequiredLibraries.forEach(function(sLibrary) {
			var oLoadLibraryPromise = sap.ui.getCore().loadLibrary(sLibrary, { async: true })
				.then(function() {
					return Promise.resolve(sLibrary);
				})
				.catch(function(vError) {
					Log.warning("Required library not available: ", vError);
					// Ignore the error here as the default delegate might not be required
					return Promise.resolve();
				});
			aLoadLibraryPromises.push(oLoadLibraryPromise);
		});
		return Promise.all(aLoadLibraryPromises);
	}

	function handleExtensibility(oControl) {
		return FieldExtensibility.onControlSelected(oControl)

		.then(function() {
			return Promise.all([
				Utils.isServiceUpToDate(oControl),
				FieldExtensibility.isExtensibilityEnabled(oControl)
			]);
		})

		.then(function(aResult) {
			var bExtensibilityEnabled = !!aResult[1];
			if (bExtensibilityEnabled) {
				return FieldExtensibility.getExtensionData(oControl);
			}
		});
	}

	/**
	 * Constructor for a new Additional Elements Plugin.
	 *
	 * The AdditionalElementsPlugin should handle the orchestration
	 * of the AdditionalElementsAnalyzer, the dialog and the command creation
	 *
	 *
	 * @param {string} [sId] id for the new object, generated automatically if no id is given
	 * @param {object} [mSettings] initial settings for the new object
	 * @class The plugin allows to add additional elements that exist either hidden in the UI or in the OData service
	 * @extends sap.ui.rta.plugin.Plugin
	 * @author SAP SE
	 * @version ${version}
	 * @constructor
	 * @private
	 * @since 1.44
	 * @alias sap.ui.rta.plugin.additionalElements.AdditionalElementsPlugin
	 * @experimental Since 1.44. This class is experimental and provides only limited functionality. Also the API might be changed in future.
	 */
	var AdditionalElementsPlugin = Plugin.extend("sap.ui.rta.plugin.additionalElements.AdditionalElementsPlugin", {
		metadata: {
			// ---- object ----

			// ---- control specific ----
			library: "sap.ui.rta",
			properties: {
				analyzer: "object", //sap.ui.rta.plugin.additionalElements.AdditionalElementsAnalyzer
				dialog: "object", //sap.ui.rta.plugin.additionalElements.AddElementsDialog
				commandFactory: "object"
			},
			associations: {},
			events: {}
		},

		getContextMenuTitle: function(bOverlayIsSibling, oOverlay, sAggregationName, bSubMenu) {
			if (bSubMenu) {
				var oTextResources = sap.ui.getCore().getLibraryResourceBundle("sap.ui.rta");
				return oTextResources.getText("CTX_ADD_ELEMENTS_WITH_SUBMENU");
			}
			var mParents = _getParents(bOverlayIsSibling, oOverlay, this);
			var mAllActions = this._getActionsOrUndef(bOverlayIsSibling, oOverlay);
			if (!sAggregationName) {
				sAggregationName = Object.keys(mAllActions)[0];
			}
			var mActions = mAllActions[sAggregationName];
			mActions.aggregation = sAggregationName;
			return _getText("CTX_ADD_ELEMENTS", mActions, mParents.parent, SINGULAR);
		},

		isAvailable: function (bOverlayIsSibling, aElementOverlays) {
			return aElementOverlays.every(function (oElementOverlay) {
				return this._isEditableByPlugin(oElementOverlay, bOverlayIsSibling);
			}, this);
		},

		isEnabled: function(bOverlayIsSibling, aElementOverlays, sAggregationName) {
			if (aElementOverlays.length > 1) {
				return false;
			}

			var oOverlay = this.getResponsibleElementOverlay(aElementOverlays[0]);
			var oParentOverlay;
			var bIsEnabled = false;
			if (bOverlayIsSibling) {
				oParentOverlay = oOverlay.getParentElementOverlay();
				if (oParentOverlay) {
					bIsEnabled = true;
				}
			} else {
				var mAllActions = this._getActionsOrUndef(bOverlayIsSibling, oOverlay);
				var mActions = mAllActions[sAggregationName];
				if (
					mActions &&
					((mActions.reveal && mActions.reveal.elements.length > 0)
					|| mActions.addViaCustom
					|| mActions.addViaDelegate)
				) {
					bIsEnabled = true;
				}
			}

			var oCachedElements = this.getCachedElements(bOverlayIsSibling);
			var bElementsAvailable = oCachedElements && oCachedElements.length > 0;
			bIsEnabled = bIsEnabled && (bElementsAvailable || !!this.getExtensibilityInfo(bOverlayIsSibling));
			return bIsEnabled;
		},

		/**
		 * Register an overlay
		 * If the MetaModel was not loaded yet when evaluating addViaDelegate, the
		 * plugin returns editable = false. Therefore we must make an extra check after
		 * the MetaModel is loaded.
		 * @param  {sap.ui.dt.Overlay} oOverlay overlay object
		 * @override
		 */
		registerElementOverlay: function(oOverlay) {
			var oModel = oOverlay.getElement().getModel();
			if (oModel) {
				var oMetaModel = oModel.getMetaModel();
				if (oMetaModel && oMetaModel.loaded) {
					oMetaModel.loaded().then(function() {
						this.evaluateEditable([oOverlay], {onRegistration: true});
					}.bind(this));
				}
			}
			Plugin.prototype.registerElementOverlay.apply(this, arguments);
		},

		_getRevealActions: function(bSibling, oSourceElementOverlay) {
			var mParents = _getParents(bSibling, oSourceElementOverlay, this);
			var aParents = [mParents.parentOverlay];
			if (mParents.relevantContainer !== mParents.parent) {
				aParents = ElementUtil.findAllSiblingsInContainer(mParents.parent, mParents.relevantContainer)
					.map(function(oParent) {
						return OverlayRegistry.getOverlay(oParent);
					})
					.filter(function (oOverlay) {
						return oOverlay;
					});
			}
			var aAggregationNames;
			if (bSibling) {
				var oParentAggregationOverlay = mParents.responsibleElementOverlay.getParentAggregationOverlay();
				aAggregationNames = oParentAggregationOverlay ? [mParents.responsibleElementOverlay.getParentAggregationOverlay().getAggregationName()] : [];
			} else {
				aAggregationNames = mParents.parentOverlay.getAggregationOverlays().filter(function(oAggregationOverlay) {
					return !oAggregationOverlay.getDesignTimeMetadata().isIgnored(mParents.parent);
				}).map(function(oAggregationOverlay) {
					return oAggregationOverlay.getAggregationName();
				});
			}

			return aAggregationNames.reduce(function(oPreviousPromise, sAggregationName) {
				return oPreviousPromise.then(function(mReveal) {
					return this._getRevealActionFromAggregations(aParents, mReveal, sAggregationName);
				}.bind(this));
			}.bind(this), Promise.resolve({}));
		},

		_getRevealActionFromAggregations: function(aParents, _mReveal, sAggregationName) {
			var aInvisibleElements = aParents.reduce(function(aInvisibleChildren, oParentOverlay) {
				return oParentOverlay ? aInvisibleChildren.concat(_getInvisibleElements.call(this, oParentOverlay, sAggregationName)) : aInvisibleChildren;
			}.bind(this), []);

			var oInitialRevealObject = {
				elements: [],
				controlTypeNames: []
			};
			var mRevealPromise = aInvisibleElements.reduce(function(oPreviousPromise, oInvisibleElement) {
				return oPreviousPromise.then(function(mReveal) {
					return this._invisibleToReveal(mReveal, oInvisibleElement);
				}.bind(this));
			}.bind(this), Promise.resolve(oInitialRevealObject));

			return mRevealPromise.then(function(mReveal) {
				if (mReveal.elements.length > 0) {
					_mReveal[sAggregationName] = {
						reveal: mReveal
					};
				}
				return _mReveal;
			});
		},

		_invisibleToReveal: function(mReveal, oInvisibleElement) {
			return Promise.resolve().then(function() {
				var oDesignTimeMetadata;
				var mRevealAction;
				var bRevealEnabled = false;
				var oHasChangeHandlerPromise = Promise.resolve();

				var oOverlay = OverlayRegistry.getOverlay(oInvisibleElement);
				if (oOverlay) {
					oDesignTimeMetadata = oOverlay.getDesignTimeMetadata();

					mRevealAction = oDesignTimeMetadata && oDesignTimeMetadata.getAction("reveal", oInvisibleElement);
					if (mRevealAction && mRevealAction.changeType) {
						var oRevealSelector = oInvisibleElement;
						if (mRevealAction.changeOnRelevantContainer) {
							oRevealSelector = oOverlay.getRelevantContainer();
						}

						oHasChangeHandlerPromise = this.hasChangeHandler(mRevealAction.changeType, oRevealSelector).then(function(bHasChangeHandler) {
							if (bHasChangeHandler) {
								if (mRevealAction.changeOnRelevantContainer) {
									//we have the child overlay, so we need the parents
									var mParents = _getParents(true, oOverlay);
									bRevealEnabled = this.hasStableId(mParents.relevantContainerOverlay)
										&& this.hasStableId(mParents.parentOverlay);
								} else {
									bRevealEnabled = true;
								}
								if (!mRevealAction.getAggregationName) {
									mRevealAction.getAggregationName = _defaultGetAggregationName;
								}
							}
						}.bind(this));
					}
				}

				return oHasChangeHandlerPromise.then(function() {
					if (bRevealEnabled) {
						mReveal.elements.push({
							element: oInvisibleElement,
							designTimeMetadata: oDesignTimeMetadata,
							action: mRevealAction
						});
						var mName = oDesignTimeMetadata.getName(oInvisibleElement);
						if (mName) {
							mReveal.controlTypeNames.push(mName);
						}
					}
					return mReveal;
				});
			}.bind(this));
		},

		/**
		 * Return the action data for additional properties.
		 * @param {boolean} bSibling - If source element overlay should be sibling or parent to the newly added fields
		 * @param {sap.ui.dt.ElementOverlay} oSourceElementOverlay - Overlay the dialog is opened for
		 * @returns {Promise<Map>} addViaDelegate action data
		 */
		_getAddViaDelegateActions: function (bSibling, oSourceElementOverlay) {
			var mParents = _getParents(bSibling, oSourceElementOverlay, this);
			var oDesignTimeMetadata = mParents.parentOverlay && mParents.parentOverlay.getDesignTimeMetadata();
			return Promise.resolve()
				.then(function() {
					var aActions = oDesignTimeMetadata ? oDesignTimeMetadata.getActionDataFromAggregations("add", mParents.parent, undefined, "delegate") : [];
					if (aActions.length) {
						return _loadKnownDefaultDelegateLibraries()
							.then(_filterValidAddPropertyActions.bind(this, aActions, mParents, this));
					}
					return [];
				}.bind(this))
				.then(function(aActions) {
					return aActions.reduce(function (oPreviousPromise, oAction) {
						return oPreviousPromise
							.then(function (oReturn) {
								return _getAddViaDelegateActionData.call(this, oAction, oDesignTimeMetadata)
									.then(function (mAction) {
										if (mAction) {
											mAction.addPropertyActionData.relevantContainer = mParents.relevantContainer;
											if (!oReturn[mAction.aggregationName]) {
												oReturn[mAction.aggregationName] = {};
											}
											oReturn[mAction.aggregationName].addViaDelegate = mAction.addPropertyActionData;
										}
										return oReturn;
									});
							}.bind(this));
					}.bind(this), Promise.resolve({}));
				}.bind(this));
		},

		_checkInvalidAddActions: function (bSibling, oSourceElementOverlay) {
			var mParents = _getParents(bSibling, oSourceElementOverlay, this);
			var oDesignTimeMetadata = mParents.parentOverlay && mParents.parentOverlay.getDesignTimeMetadata();
			var aActions = oDesignTimeMetadata ? oDesignTimeMetadata.getActionDataFromAggregations("addODataProperty", mParents.parent) : [];
			if (aActions.length > 0) {
				Log.error("Outdated addODataProperty action in designtime metadata in " + oDesignTimeMetadata.getData().designtimeModule + " or propagated or via instance specific designtime metadata.");
			}
		},

		_getCustomAddActions: function (bSibling, oOverlay) {
			var mParents = _getParents(bSibling, oOverlay, this);
			var oDesignTimeMetadata = mParents.parentOverlay && mParents.parentOverlay.getDesignTimeMetadata();
			var aActions = oDesignTimeMetadata && oDesignTimeMetadata.getActionDataFromAggregations("add", mParents.parent, undefined, "custom") || [];

			function getAction(mAction, oCheckElement) {
				var aItems = [];
				return Promise.resolve()
					.then(function () {
						if (mAction && typeof mAction.getItems === "function") {
							var oCheckElementOverlay = OverlayRegistry.getOverlay(oCheckElement);
							if (this.hasStableId(oCheckElementOverlay)) {
								return mAction.getItems(oCheckElement);
							}
						}
					}.bind(this))
					.then(function (aItemsFromAction) {
						aItems = aItemsFromAction;
						if (Array.isArray(aItems)) {
							var aChangeHandlerPromises = aItems.reduce(function (aPromises, oItem) {
								// adjust relevant container
								if (oItem.changeSpecificData.changeOnRelevantContainer) {
									oCheckElement = mParents.relevantContainer;
								}
								if (oItem.changeSpecificData.changeType) {
									aPromises.push(this.hasChangeHandler(oItem.changeSpecificData.changeType, oCheckElement));
								}
								return aPromises;
							}.bind(this), []);

							return Promise.all(aChangeHandlerPromises);
						}
					}.bind(this))
					.then(function (aHasChangeHandlerForCustomItems) {
						if (
							Array.isArray(aHasChangeHandlerForCustomItems)
							&& aItems.length === aHasChangeHandlerForCustomItems.length
							&& aHasChangeHandlerForCustomItems.indexOf(false) === -1
						) {
							return {
								aggregationName: mAction.aggregation,
								addViaCustom: {
									designTimeMetadata: oDesignTimeMetadata,
									action: mAction,
									items: aItems
								}
							};
						}
					});
			}

			var oCheckElement = mParents.parent;
			return aActions.reduce(function(oPreviousPromise, oAction) {
				return oPreviousPromise.then(function(oReturn) {
					return getAction.call(this, oAction, oCheckElement).then(function(mAction) {
						if (mAction) {
							oReturn[mAction.aggregationName] = {
								addViaCustom: mAction.addViaCustom
							};
						}
						return oReturn;
					});
				}.bind(this));
			}.bind(this), Promise.resolve({}));
		},

		/**
		 * Calculate a map with all "add/reveal" action relevant data collected per aggregation:
		 * <pre>
		 * {
		 *	<aggregationName> : {
		 *		addViaDelegate : {
		 *			designTimeMetadata : <sap.ui.dt.ElementDesignTimeMetadata of parent>,
		 *			action : <add.delegate action section from designTimeMetadata>
		 *		},
		 *		reveal : {
		 *			elements : [{
		 *				element : <invisible element>,
		 *				designTimeMetadata : <sap.ui.dt.ElementDesignTimeMetadata of invisible element>,
		 *				action : <reveal action section from designTimeMetadata>
		 *			}],
		 *			controlTypeNames : string[] <all controlTypeNames collected via designTimeMetadata>
		 *		},
		 *		addViaCustom : {
		 *			designTimeMetadata : <sap.ui.dt.ElementDesignTimeMetadata of parent>,
		 *			action : <add.custom action section from designTimeMetadata>
		 *			items : <add.custom action's array of items from the getItems() function>
		 *		}
		 *	},
		 *	<aggregationName2> : ...
		 * }
		 * </pre>
		 *
		 * @param {boolean} bSibling - indicates if the elements should be added as sibling (true) or child (false) to the overlay
		 * @param {sap.ui.dt.ElementOverlay} oSourceElementOverlay - Elements will be added in relation (sibling/parent) to this overlay
		 * @param {boolean} [bInvalidate] - Option to prevent cached actions to be returned
		 *
		 * @return {Map} - returns a map with all "add/reveal" action relevant data collected
		 * @private
		 */
		_getActions: function(bSibling, oSourceElementOverlay, bInvalidate) {
			return new Promise(function(resolve, reject) {
				var sSiblingOrChild = bSibling ? "asSibling" : "asChild";
				if (!bInvalidate && oSourceElementOverlay._mAddActions) {
					return resolve(oSourceElementOverlay._mAddActions[sSiblingOrChild]);
				}

				var oRevealActionsPromise = this._getRevealActions(bSibling, oSourceElementOverlay);
				var oAddPropertyActionsPromise = this._getAddViaDelegateActions(bSibling, oSourceElementOverlay);
				var oCustomAddActionsPromise = this._getCustomAddActions(bSibling, oSourceElementOverlay);

				return Promise.all([
					oRevealActionsPromise,
					oAddPropertyActionsPromise,
					oCustomAddActionsPromise,
					this._checkInvalidAddActions(bSibling, oSourceElementOverlay)
				])
					.then(function(aAllActions) {
						//join and condense all action data
						var mAllActions = merge(aAllActions[0], aAllActions[1], aAllActions[2]);
						oSourceElementOverlay._mAddActions = oSourceElementOverlay._mAddActions || {asSibling: {}, asChild: {}};
						oSourceElementOverlay._mAddActions[sSiblingOrChild] = mAllActions;
						resolve(mAllActions);
					})
					.catch(function (vError) {
						reject(vError);
					});
			}.bind(this));
		},

		_getActionsOrUndef: function(bSibling, oOverlay) {
			var sSiblingOrChild = bSibling ? "asSibling" : "asChild";
			return oOverlay._mAddActions && oOverlay._mAddActions[sSiblingOrChild];
		},

		_checkIfCreateFunctionIsAvailable: function(mChangeHandlerSettings) {
			return !mChangeHandlerSettings ||
				(
					mChangeHandlerSettings &&
					mChangeHandlerSettings.content &&
					mChangeHandlerSettings.content.createFunction
				);
		},

		/**
		 * Opens a dialog containing all the elements that can be added for a control and aggregation
		 * @param {boolean} bOverlayIsSibling Indicates if the elements should be added as sibling (true) or child (false) to the overlay
		 * @param {string} sAggregationName The name of the aggregation to where the elements can be added
		 * @param {Array<sap.ui.dt.ElementOverlay>} aResponsibleElementOverlays Array containing the overlay of the control
		 * @param {number} [iIndex] The position where the element will be added
		 * @param {string} [sControlName] The name of the control
		 * @param {sDisplayText} [sDisplayText] The display text of the control for the dialog
		 *
		 * @return {Promise} Returns a promise that resolves when the dialog closes
		 * @private
		 */
		showAvailableElements: function(bOverlayIsSibling, sAggregationName, aResponsibleElementOverlays, iIndex, sControlName, sDisplayText) {
			var oResponsibleElementOverlay = aResponsibleElementOverlays[0];
			var mParents = _getParents(bOverlayIsSibling, oResponsibleElementOverlay);
			var vSiblingElement = bOverlayIsSibling && oResponsibleElementOverlay.getElement();
			var mActions;
			var aAllElements = [];

			return this._getActions(bOverlayIsSibling, oResponsibleElementOverlay)
				.then(function(mAllActions) {
					if (Object.keys(mAllActions).length > 0) {
						mActions = mAllActions[sAggregationName];
						if (mActions) {
							mActions.aggregation = sAggregationName;
						}
					}
				})

				.then(function() {
					return this.getAllElements(bOverlayIsSibling, [mParents.responsibleElementOverlay], sControlName, sDisplayText);
				}.bind(this))

				.then(function(aCollectedElements) {
					aAllElements = aCollectedElements;
					// getAllElements() also sets the extensibility info
					var oExtensibilityInfo = this.getExtensibilityInfo(bOverlayIsSibling);
					this.getDialog().setCustomFieldEnabled(!!oExtensibilityInfo);
					if (oExtensibilityInfo) {
						this.getDialog().detachEvent("openCustomField", this._onOpenCustomField, this);
						this.getDialog().attachEvent("openCustomField", bOverlayIsSibling, this._onOpenCustomField, this);
						this.getDialog()._oCustomFieldButton.setVisible(true);
						return this.getDialog().addExtensionData(oExtensibilityInfo.extensionData);
					}
					this.getDialog()._oCustomFieldButton.setVisible(false);
				}.bind(this))

				.then(function() {
					var oAggregationWithElements = aAllElements.filter(function(mElementsPerAggregation) {
						return mElementsPerAggregation.aggregation === sAggregationName;
					})[0];
					var aElementsPerAggregation = oAggregationWithElements ? oAggregationWithElements.elements : [];

					this.getDialog().setElements(aElementsPerAggregation);
					if (sDisplayText) {
						//Aggregation is part of title
						var oTextResources = sap.ui.getCore().getLibraryResourceBundle("sap.ui.rta");
						var sDialogTitle = oTextResources.getText("HEADER_ADDITIONAL_ELEMENTS_WITH_AGGREGATION", sDisplayText);
						this.getDialog().setTitle(sDialogTitle);
					} else if (mActions && (mActions.aggregation || sControlName)) {
						//Only one aggregation, no aggregation in title
						this._setDialogTitle(mActions, mParents.parent, sControlName);
					}

					return this.getDialog().open()

						.then(function() {
							return this._createCommands(mParents, vSiblingElement, mActions, iIndex);
						}.bind(this))

						.then(function() {
							var oOverlayToFocus = OverlayRegistry.getOverlay(vSiblingElement) || oResponsibleElementOverlay;
							oOverlayToFocus.focus();
						})

						.catch(function(oError) {
							//no error means canceled dialog
							if (oError instanceof Error) {
								throw oError;
							}
						});
				}.bind(this))

				.catch(function(oError) {
					if (oError instanceof Error) {
						throw oError;
					} else {
						Log.info("Service not up to date, skipping add dialog", "sap.ui.rta");
					}
				});
		},

		_setDialogTitle: function(mActions, oParentElement, sControlName) {
			var sDialogTitle = _getText("HEADER_ADDITIONAL_ELEMENTS", mActions, oParentElement, PLURAL, sControlName);
			this.getDialog().setTitle(sDialogTitle);
			if (sControlName) {
				this.getDialog()._oList.setNoDataText(this.getDialog()._oTextResources.getText("MSG_NO_FIELDS", sControlName.toLowerCase()));
			}
		},

		/**
		 * Function called when custom field button was pressed
		 *
		 */
		_onOpenCustomField: function (oEvent, bOverlayIsSibling) {
			var sRtaStyleClassName = Utils.getRtaStyleClassName();
			return FieldExtensibility.onTriggerCreateExtensionData(this.getExtensibilityInfo(bOverlayIsSibling), sRtaStyleClassName);
		},

		_createCommands: function(mParents, oSiblingElement, mActions, iIndex) {
			var aSelectedElements = this.getDialog().getSelectedElements();

			// sort elements by label in descending order. When added the fields will be in ascending order on the UI
			aSelectedElements.sort(function(oElement1, oElement2) {
				if (oElement1.label > oElement2.label) {
					return -1;
				}
				if (oElement1.label < oElement2.label) {
					return 1;
				}
				return 0;
			});

			if (aSelectedElements.length > 0) {
				//at least one element selected
				return this.getCommandFactory().getCommandFor(mParents.parent, "composite")

					.then(function(oCompositeCommand) {
						var oPromise = Promise.resolve();
						aSelectedElements.forEach(function(oSelectedElement) {
							switch (oSelectedElement.type) {
								case "invisible":
									oPromise = oPromise.then(
										this._createCommandsForInvisibleElement.bind(this, oCompositeCommand, oSelectedElement, mParents, oSiblingElement, mActions, iIndex));
									break;
								case "delegate":
									oPromise = oPromise.then(
										this._createCommandsForAddViaDelegate.bind(this, oCompositeCommand, oSelectedElement, mParents, oSiblingElement, mActions, iIndex));
									break;
								case "custom":
									oPromise = oPromise.then(
										this._createCommandsForCustomElement.bind(this, oCompositeCommand, oSelectedElement, mParents, oSiblingElement, mActions, iIndex));
									break;
								default:
									Log.error("Can't create command for untreated element.type " + oSelectedElement.type);
							}
						}, this);
						return oPromise.then(function() { return oCompositeCommand; });
					}.bind(this))

					.then(function(oCompositeCommand) {
						this.fireElementModified({
							command: oCompositeCommand
						});
					}.bind(this))

					.catch(function(vMessage) {
						throw DtUtils.propagateError(
							vMessage,
							"AdditionalElementsPlugin#_createCommands",
							"Error occured during _createCommands execution",
							"sap.ui.rta.plugin"
						);
					});
			}
			return Promise.resolve();
		},

		_createCommandsForInvisibleElement: function(oCompositeCommand, oSelectedElement, mParents, oSiblingElement, mActions, iIndex) {
			return this._createRevealCommandForInvisible(oSelectedElement, mActions, mParents)

				.then(function(oRevealCommandForInvisible) {
					oCompositeCommand.addCommand(oRevealCommandForInvisible);
					return this._createMoveCommandForInvisible(oSelectedElement, mParents, oSiblingElement, iIndex);
				}.bind(this))

				.then(function(oMoveCommandForInvisible) {
					if (oMoveCommandForInvisible) {
						oCompositeCommand.addCommand(oMoveCommandForInvisible);
					} else {
						Log.warning("No move action configured for " + mParents.parent.getMetadata().getName() + ", aggregation: " + mActions.aggregation, "sap.ui.rta");
					}
					return oCompositeCommand;
				});
		},

		_createCommandForAddLibrary: function(mParents, mRequiredLibraries, oParentAggregationDTMetadata) {
			if (mRequiredLibraries) {
				var oComponent = FlUtils.getAppComponentForControl(mParents.relevantContainer);
				var bLibsMissing = _areLibDependenciesMissing(oComponent, mRequiredLibraries);
				if (bLibsMissing) {
					var mManifest = oComponent.getManifest();
					var sReference = mManifest["sap.app"].id;
					return this.getCommandFactory().getCommandFor(mParents.publicParent, "addLibrary", {
						reference: sReference,
						parameters: { libraries: mRequiredLibraries },
						appComponent: oComponent
					}, oParentAggregationDTMetadata);
				}
			}
			return Promise.resolve();
		},

		_createRevealCommandForInvisible: function(mSelectedElement, mActions, mParents) {
			var oRevealedElement = ElementUtil.getElementInstance(mSelectedElement.elementId);
			var oRevealedElementOverlay = OverlayRegistry.getOverlay(oRevealedElement);
			var mRevealData = _getRevealDataFromActions(mActions, oRevealedElement);

			var oDesignTimeMetadata = mRevealData.designTimeMetadata;
			var oRevealAction = mRevealData.action;

			var sVariantManagementReference;
			if (oRevealedElementOverlay) {
				sVariantManagementReference = this.getVariantManagementReference(oRevealedElementOverlay);
			}

			if (oRevealAction.changeOnRelevantContainer) {
				return this.getCommandFactory().getCommandFor(oRevealedElement, "reveal", {
					revealedElementId: oRevealedElement.getId(),
					directParent: mParents.parent
				}, oDesignTimeMetadata, sVariantManagementReference);
			}
			return this.getCommandFactory().getCommandFor(oRevealedElement, "reveal", { }, oDesignTimeMetadata, sVariantManagementReference);
		},

		_createMoveCommandForInvisible: function(oSelectedElement, mParents, oSiblingElement, iIndex) {
			var oRevealedElement = ElementUtil.getElementInstance(oSelectedElement.elementId);
			var oRevealedElementOverlay = OverlayRegistry.getOverlay(oRevealedElement);
			var sParentAggregationName = oRevealedElementOverlay.getParentAggregationOverlay().getAggregationName();
			var oSourceParent = oRevealedElementOverlay.getParentElementOverlay().getElement() || mParents.parent;
			var oTargetParent = mParents.parent;
			var iRevealTargetIndex = Utils.getIndex(mParents.parent, oSiblingElement, sParentAggregationName);
			var iRevealedSourceIndex = Utils.getIndex(oSourceParent, oRevealedElement, sParentAggregationName) - 1;

			iRevealTargetIndex = iIndex !== undefined ? iIndex : ElementUtil.adjustIndexForMove(oSourceParent, oTargetParent, iRevealedSourceIndex, iRevealTargetIndex);

			if (iRevealTargetIndex !== iRevealedSourceIndex || mParents.parent !== oRevealedElement.getParent()) {
				var oSourceParentOverlay = OverlayRegistry.getOverlay(oRevealedElement) ? OverlayRegistry.getOverlay(oRevealedElement).getParentAggregationOverlay() : mParents.relevantContainerOverlay;
				var SourceParentDesignTimeMetadata = oSourceParentOverlay.getDesignTimeMetadata();
				var sVariantManagementReference = this.getVariantManagementReference(oRevealedElementOverlay);

				return this.getCommandFactory().getCommandFor(mParents.relevantContainer, "move", {
					movedElements: [{
						element: oRevealedElement,
						sourceIndex: iRevealedSourceIndex,
						targetIndex: iRevealTargetIndex
					}],
					source: {
						parent: oSourceParent,
						aggregation: sParentAggregationName
					},
					target: {
						parent: oTargetParent,
						aggregation: sParentAggregationName
					}
				}, SourceParentDesignTimeMetadata, sVariantManagementReference);
			}
			return Promise.resolve();
		},

		_createCommandsForCustomElement: function (oCompositeCommand, oSelectedElement, mParents, oSiblingElement, mActions, iIndex) {
			var oElement = mParents.parent;
			var oParentAggregationDTMetadata = mParents.parentOverlay.getAggregationOverlay(mActions.aggregation).getDesignTimeMetadata();
			var oActionSettings = Object.assign(
				{
					changeOnRelevantContainer: oSelectedElement.changeSpecificData.changeOnRelevantContainer,
					aggregationName: mActions.aggregation,
					changeType: oSelectedElement.changeSpecificData.changeType,
					addElementInfo: oSelectedElement.changeSpecificData.content,
					index: iIndex || Utils.getIndex(mParents.parent, oSiblingElement, mActions.aggregation)
				},
				oSelectedElement.itemId && { customItemId: oSelectedElement.itemId }
			);

			var sVariantManagementReference;
			if (mParents.relevantContainerOverlay) {
				sVariantManagementReference = this.getVariantManagementReference(mParents.relevantContainerOverlay);
			}

			return this.getCommandFactory().getCommandFor(oElement, "customAdd", oActionSettings, oParentAggregationDTMetadata, sVariantManagementReference)
				.then(function (oCustomAddCommand) {
					if (oCustomAddCommand) {
						oCompositeCommand.addCommand(oCustomAddCommand);
					}
					return oCompositeCommand;
				});
		},

		_createCommandsForAddViaDelegate: function(oCompositeCommand, oSelectedElement, mParents, oSiblingElement, mActions, iIndex) {
			var mAddViaDelegateAction = mActions.addViaDelegate.action;
			var mRequiredLibraries = mAddViaDelegateAction.delegateInfo.requiredLibraries;
			var oParentAggregationOverlay = mParents.parentOverlay.getAggregationOverlay(mActions.aggregation);
			var oParentAggregationDTMetadata = oParentAggregationOverlay.getDesignTimeMetadata();
			return this._createCommandForAddLibrary(mParents, mRequiredLibraries, oParentAggregationDTMetadata)
				.then(function(oCommandForAddLibrary) {
					if (oCommandForAddLibrary) {
						oCompositeCommand.addCommand(oCommandForAddLibrary);
					}
					return this._createAddViaDelegateCommand(oSelectedElement, mParents, oParentAggregationDTMetadata, oSiblingElement, mActions, iIndex);
				}.bind(this))
				.then(function(oAddViaDelegateCommand) {
					if (oAddViaDelegateCommand) {
						oCompositeCommand.addCommand(oAddViaDelegateCommand);
					}
					return oCompositeCommand;
				});
		},

		_createAddViaDelegateCommand: function(oSelectedElement, mParents, oParentAggregationDTMetadata, oSiblingElement, mActions, iIndex) {
			var mAddViaDelegateAction = mActions.addViaDelegate.action;
			var oParent = mAddViaDelegateAction.changeOnRelevantContainer ? mParents.relevantContainer : mParents.parent;
			var oParentOverlay = mAddViaDelegateAction.changeOnRelevantContainer ? mParents.relevantContainerOverlay : mParents.parentOverlay;
			var sVariantManagementReference = this.getVariantManagementReference(oParentOverlay);
			var iAddTargetIndex = Utils.getIndex(mParents.parent, oSiblingElement, mActions.aggregation, oParentAggregationDTMetadata.getData().getIndex);
			var sCommandName = "addDelegateProperty";
			var oManifest = FlUtils.getAppComponentForControl(mParents.parent).getManifest();
			var sServiceUri = FlUtils.getODataServiceUriFromManifest(oManifest);

			return this.getCommandFactory().getCommandFor(mParents.parent, sCommandName, {
				newControlId: Utils.createFieldLabelId(oParent, oSelectedElement.entityType, oSelectedElement.bindingPath),
				index: iIndex !== undefined ? iIndex : iAddTargetIndex,
				bindingString: oSelectedElement.bindingPath,
				entityType: oSelectedElement.entityType, // needed for custom field support tool
				parentId: mParents.parent.getId(),
				propertyName: oSelectedElement.name,
				oDataServiceVersion: oSelectedElement.oDataServiceVersion,
				oDataServiceUri: sServiceUri,
				modelType: mAddViaDelegateAction.delegateInfo.modelType,
				relevantContainerId: mParents.relevantContainer.getId()
			}, oParentAggregationDTMetadata, sVariantManagementReference);
		},

		/**
		 * This function gets called on startup. It checks if the Overlay is editable by this plugin.
		 * @param {sap.ui.dt.Overlay} oOverlay - overlay to be checked
		 * @returns {object} Returns object with editable boolean values for "asChild" and "asSibling"
		 * @protected
		 */
		_isEditable: function(oOverlay, mPropertyBag) {
			return Promise.all([this._isEditableCheck(mPropertyBag.sourceElementOverlay, true), this._isEditableCheck(mPropertyBag.sourceElementOverlay, false)])
				.then(function(aPromiseValues) {
					return {
						asSibling: aPromiseValues[0],
						asChild: aPromiseValues[1]
					};
				})
				.catch(function (vError) {
					Log.error(vError);
				});
		},

		_isEditableCheck: function(oOverlay, bOverlayIsSibling) {
			return Promise.resolve()
				.then(function() {
					var mParents = _getParents(bOverlayIsSibling, oOverlay, this);

					if (!mParents.relevantContainerOverlay) {
						return false;
					}

					return this._getActions(bOverlayIsSibling, oOverlay, true)
						.then(function (mActions) {
							return Utils.doIfAllControlsAreAvailable([oOverlay, mParents.parentOverlay], function () {
								var bEditable = false;
								if (bOverlayIsSibling) {
									bEditable = _isThereAnAggregationActionForSameAggregation(mActions, mParents);
								}

								return Object.keys(mActions).some(function(sAggregationName) {
									if (!bEditable && mActions[sAggregationName].reveal) {
										//reveal is handled locally
										bEditable = true;
									}

									if (!bEditable && !bOverlayIsSibling) {
										if (mActions[sAggregationName].addViaDelegate) {
											bEditable = this.checkAggregationsOnSelf(mParents.parentOverlay, "add", undefined, "delegate");
										}
									}
									if (!bEditable && !bOverlayIsSibling && mActions[sAggregationName].addViaCustom) {
										bEditable = true;
									}
									return bEditable;
								}.bind(this));
							}.bind(this));
						}.bind(this))
						.then(function (bEditable) {
							if (bEditable) {
								bEditable =
									this.hasStableId(oOverlay) //don't confuse the user/Web IDE by an editable overlay without stable ID
									&& this.hasStableId(mParents.parentOverlay);
							}
							return bEditable;
						}.bind(this));
				}.bind(this));
		},

		/**
		 * Returns all the elements that can be added to a control
	 	 * @param {boolean} bOverlayIsSibling - Indicates if the elements would be added as sibling (instead of child)
		 * @param {Array<sap.ui.dt.ElementOverlay>} aElementOverlays - Array containing the overlay of the control
		 * @returns {Array} An array with all elements
		 * @protected
		 */
		getAllElements: function(bOverlayIsSibling, aElementOverlays) {
			var oElementOverlay = aElementOverlays[0];
			var mParents = _getParents(bOverlayIsSibling, oElementOverlay, this);
			var mActions;
			var aPromises = [];
			var bCheckExtensibility = false;
			var aCachedElements = this.getCachedElements(bOverlayIsSibling);

			if (aCachedElements) {
				return aCachedElements;
			}

			this.clearExtensibilityInfo(bOverlayIsSibling);

			return this._getActions(bOverlayIsSibling, oElementOverlay)
				.then(function(mAllActions) {
					each(mAllActions, function(sAggregationName) {
						mActions = mAllActions[sAggregationName];
						mActions.aggregation = sAggregationName;
						if (mActions.addViaDelegate) {
							bCheckExtensibility = true;
						}
						aPromises.push({
							aggregation: sAggregationName,
							elementPromises: [
								mActions.reveal ? this.getAnalyzer().enhanceInvisibleElements(mParents.parent, mActions) : Promise.resolve([]),
								mActions.addViaDelegate ? this.getAnalyzer().getUnrepresentedDelegateProperties(mParents.parent, mActions.addViaDelegate) : Promise.resolve([]),
								mActions.addViaCustom ? this.getAnalyzer().getCustomAddItems(mParents.parent, mActions.addViaCustom, mActions.aggregation) : Promise.resolve([])
							]
						});
					}.bind(this));
					if (bCheckExtensibility) {
						return handleExtensibility(mParents.parent);
					}
				}.bind(this))

				.then(function(oExtensibilityInfo) {
					this.setExtensibilityInfo(bOverlayIsSibling, oExtensibilityInfo);
				}.bind(this))

				.then(this._combineAnalyzerResults.bind(this, aPromises))

				.then(function(aAllElements) {
					this.setCachedElements(aAllElements, bOverlayIsSibling);
					return aAllElements;
				}.bind(this))

				.catch(function(oError) {
					throw oError;
				});
		},

		/**
		 * Retrieve the context menu item for the actions.
		 * Two items are returned here: one for when the overlay is sibling and one for when it is child. In case of multiple
		 * aggregations for child elements, a submenu is built containing all aggregations and the sibling.
		 * @param  {sap.ui.dt.ElementOverlay} aElementOverlays - List of overlays for which the context menu was opened
		 * @return {object[]} Returns array containing the items with required data
		 */
		getMenuItems: function (aElementOverlays) {
			var aMenuItems = [];
			var oMenuItem;
			this.clearCachedElements();
			// getAllElements() is called to set cached elements for the overlay -> which will result in menu item being enabled
			return Promise.all([this.getAllElements(false, aElementOverlays), this.getAllElements(true, aElementOverlays)])
			.then(function(aElementsWithAggregations) {
				var bHasChildren = aElementsWithAggregations[0].length > 0;
				var bHasMultipleAggregations = aElementsWithAggregations[0].length > 1;
				var bHasSiblings = aElementsWithAggregations[1].length > 0;
				var bIsAvailableForChildren = this.isAvailable(false, aElementOverlays);
				var bIsAvailableForSibling = this.isAvailable(true, aElementOverlays);
				if (bIsAvailableForSibling && (!bIsAvailableForChildren || !bHasChildren)) {
					// Case 1: Only siblings -> No submenu required
					oMenuItem = this._buildMenuItem("CTX_ADD_ELEMENTS_AS_SIBLING", true, aElementOverlays, aElementsWithAggregations, false);
				} else if (!bIsAvailableForSibling && bIsAvailableForChildren && !bHasMultipleAggregations) {
					// Case 2: Only children, one aggregation -> No submenu required
					oMenuItem = this._buildMenuItem("CTX_ADD_ELEMENTS_AS_CHILD", false, aElementOverlays, aElementsWithAggregations, false);
				} else if (!bIsAvailableForSibling && bIsAvailableForChildren && bHasMultipleAggregations) {
					// Case 3: Only children, multiple aggregations -> Submenu required
					oMenuItem = this._buildMenuItem("CTX_ADD_ELEMENTS_AS_CHILD", false, aElementOverlays, aElementsWithAggregations, true);
				} else if (bIsAvailableForChildren && bIsAvailableForSibling && bHasChildren && bHasSiblings) {
					// Case 4: Children and siblings -> Submenu required
					oMenuItem = this._buildMenuItem("CTX_ADD_ELEMENTS_CHILD_AND_SIBLING", false, aElementOverlays, aElementsWithAggregations, true);
				}
				if (oMenuItem) {
					aMenuItems.push(this.enhanceItemWithResponsibleElement(oMenuItem, aElementOverlays, ["addViaDelegate", "reveal", "custom"]));
				}
				return aMenuItems;
			}.bind(this));
		},

		_buildMenuItem: function(sPluginId, bOverlayIsSibling, aElementOverlays, aElementsWithAggregations, bHasSubMenu) {
			var aSubMenuItems;
			var vHandler;
			var aRelevantElements = bOverlayIsSibling ? aElementsWithAggregations[1] : aElementsWithAggregations[0];
			var sAggregationName = aRelevantElements[0] && aRelevantElements[0].aggregation;
			if (bHasSubMenu) {
				// The children are displayed before the sibling
				aSubMenuItems = this._buildSubmenuItems(false, aElementOverlays, aElementsWithAggregations[0]);
				if (sPluginId === "CTX_ADD_ELEMENTS_CHILD_AND_SIBLING") {
					aSubMenuItems = aSubMenuItems.concat(this._buildSubmenuItems(true, aElementOverlays, aElementsWithAggregations[1]));
				}
			} else {
				vHandler = function (bOverlayIsSibling, aElementOverlays) {
					return this.showAvailableElements(bOverlayIsSibling, sAggregationName, aElementOverlays);
				}.bind(this, bOverlayIsSibling);
			}
			var oMenuItem = {
				id: sPluginId,
				text: this.getContextMenuTitle.bind(this, bOverlayIsSibling, aElementOverlays[0], sAggregationName, bHasSubMenu),
				enabled: bHasSubMenu || function(bOverlayIsSibling, aElementOverlays) {
					return this.isEnabled(bOverlayIsSibling, aElementOverlays, sAggregationName);
				}.bind(this, bOverlayIsSibling),
				rank: 20,
				icon: "sap-icon://add",
				handler: vHandler
			};
			if (bHasSubMenu) {
				oMenuItem.submenu = aSubMenuItems;
			}
			return oMenuItem;
		},

		_buildSubmenuItems: function(bOverlayIsSibling, aElementOverlays, aElementsWithAggregation) {
			var aSubMenuItems = [];
			var sPluginId = bOverlayIsSibling ? "CTX_ADD_ELEMENTS_AS_SIBLING" : "CTX_ADD_ELEMENTS_AS_CHILD";
			var iPosition = 0;

			// register BusinessSuite icon font
			IconPool.registerFont({
				collectionName: "BusinessSuiteInAppSymbols",
				fontFamily: "BusinessSuiteInAppSymbols",
				fontURI: sap.ui.require.toUrl("sap/ushell/themes/base/fonts/"),
				lazy: true
			});

			function getMenuItemText(bOverlayIsSibling, sAggregationName, aElementOverlays) {
				var oElementOverlay = bOverlayIsSibling ? aElementOverlays[0].getParentElementOverlay() : aElementOverlays[0];
				var oNames = oElementOverlay.getDesignTimeMetadata().getAggregationDisplayName(sAggregationName, oElementOverlay.getElement());
				return oNames ? oNames.singular : sAggregationName;
			}
			aElementsWithAggregation.forEach(function(mElementsWithAggregation) {
				var sAggregationName = mElementsWithAggregation.aggregation;
				var sDisplayText = getMenuItemText(bOverlayIsSibling, sAggregationName, aElementOverlays);
				var oItem = {
					id: sPluginId + '_' + iPosition,
					text: sDisplayText,
					enabled: function(bOverlayIsSibling, aElementOverlays) {
						return this.isEnabled(bOverlayIsSibling, aElementOverlays, sAggregationName);
					}.bind(this, bOverlayIsSibling),
					handler: function (bOverlayIsSibling, aElementOverlays) {
						// showAvailableElements has optional parameters
						return this.showAvailableElements(bOverlayIsSibling, sAggregationName, aElementOverlays, undefined, undefined, sDisplayText);
					}.bind(this, bOverlayIsSibling),
					icon: bOverlayIsSibling ? "sap-icon://BusinessSuiteInAppSymbols/icon-add-outside" : "sap-icon://add"
				};
				aSubMenuItems.push(this.enhanceItemWithResponsibleElement(oItem, aElementOverlays, ["addViaDelegate", "reveal", "custom"]));
				iPosition++;
			}.bind(this));
			return aSubMenuItems;
		},

		// aAllPromises:
		// [
		// 	{
		// 		aggregation: "aggregation1",
		// 		elementPromises: [
		// 			revealPromise,
		// 			addViaDelegatePromise,
		// 			addViaCustomPromise
		// 		]
		// 	},
		// 	{
		// 		aggregation: "aggregation2",
		// 		elementPromises: [
		// 			revealPromise,
		// 			addViaDelegatePromise,
		// 			addViaCustomPromise
		// 		]
		// 	}
		// 	...
		// ]
		//
		// Return:
		// [
		// 	{
		// 		aggregation: "aggregation1",
		// 		elements: [...]
		// 	},
		// 	{
		// 		aggregation: "aggregation2",
		// 		elements: [...]
		// 	}
		// ]
		_combineAnalyzerResults: function(aAllPromises) {
			var aCollectedPromises = [];

			aAllPromises.forEach(function(aPromisesByAggregation) {
				aCollectedPromises.push(
					Promise.all(aPromisesByAggregation.elementPromises).then(function(aAnalyzerValues) {
						return {
							aggregation: aPromisesByAggregation.aggregation,
							elements: this.getAnalyzer().getFilteredItemsList(aAnalyzerValues)
						};
					}.bind(this))
				);
			}.bind(this));

			return Promise.all(aCollectedPromises)
				.then(function(aElementsPerAggregation) {
					// Filter out results without elements
					return aElementsPerAggregation.filter(function(oElementsPerAggregation) {
						var aElements = oElementsPerAggregation && oElementsPerAggregation.elements;
						return aElements.length > 0;
					});
				});
		},

		clearCachedElements: function() {
			this._oCachedElements = undefined;
		},

		setCachedElements: function (aElements, bOverlayIsSibling) {
			this._oCachedElements = this._oCachedElements || {};
			this._oCachedElements[bOverlayIsSibling ? "asSibling" : "asChild"] = aElements;
		},

		getCachedElements: function (bOverlayIsSibling) {
			if (this._oCachedElements) {
				return this._oCachedElements[bOverlayIsSibling ? "asSibling" : "asChild"];
			}
		},

		clearExtensibilityInfo: function(bOverlayIsSibling) {
			if (this._oExtensibilityInfo) {
				this._oExtensibilityInfo[bOverlayIsSibling ? "asSibling" : "asChild"] = undefined;
			}
		},

		setExtensibilityInfo: function(bOverlayIsSibling, oExtensibilityInfo) {
			this._oExtensibilityInfo = this._oExtensibilityInfo || {};
			this._oExtensibilityInfo[bOverlayIsSibling ? "asSibling" : "asChild"] = oExtensibilityInfo;
		},

		getExtensibilityInfo: function(bOverlayIsSibling) {
			if (this._oExtensibilityInfo) {
				return this._oExtensibilityInfo[bOverlayIsSibling ? "asSibling" : "asChild"];
			}
		}

	});

	return AdditionalElementsPlugin;
});
