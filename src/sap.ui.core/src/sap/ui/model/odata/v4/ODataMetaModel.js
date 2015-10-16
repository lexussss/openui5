/*!
 * ${copyright}
 */

//Provides class sap.ui.model.odata.v4.ODataMetaModel
sap.ui.define([
	'sap/ui/model/MetaModel',
	"sap/ui/model/odata/ODataUtils",
	'sap/ui/model/odata/v4/_ODataHelper'
], function (MetaModel, ODataUtils, Helper) {
	"use strict";

	var rEntitySetName = /^(\w+)(\[|\(|$)/, // identifier followed by [,( or at end of string
		rNumber = /^\d+$/;

	/**
	 * Do <strong>NOT</strong> call this private constructor for a new <code>ODataMetaModel</code>,
	 * but rather use {@link sap.ui.model.odata.v4.ODataModel#getMetaModel getMetaModel} instead.
	 *
	 * @param {object} oModel
	 *   an interface to the meta model having the two methods <code>requestEntityContainer</code>
	 *   and <code>requestEntityType</code>.
	 *
	 * @class Implementation of an OData meta model which offers access to OData v4 meta data.
	 *
	 * This model is read-only.
	 *
	 * @author SAP SE
	 * @version ${version}
	 * @alias sap.ui.model.odata.v4.ODataMetaModel
	 * @extends sap.ui.model.MetaModel
	 * @public
	 * @since 1.31.0
	 */
	var ODataMetaModel = MetaModel.extend("sap.ui.model.odata.v4.ODataMetaModel", {
			constructor : function (oModel) {
				MetaModel.call(this);
				if (!oModel) {
					throw new Error("Missing metadata model");
				}
				this.oModel = oModel;
				// @see sap.ui.model.odata.v4._ODataHelper.requestEntityContainer
				this._oEntityContainerPromise = null;
			}
		});

	/**
	 * Throws an error with the given text and the given path.
	 * @param {string} sError
	 *   the error text
	 * @param {string} sPath
	 *   the path
	 */
	function error(sError, sPath) {
		throw new Error(sError + ": " + sPath);
	}

	/**
	 * Returns a promise for the "4.3.1 Canonical URL" corresponding to the given service root URL
	 * and absolute data binding path which must point to an entity.
	 *
	 * @param {string} sServiceUrl
	 *   root URL of the service
	 * @param {string} sPath
	 *   an absolute data binding path pointing to an entity, e.g.
	 *   "/TEAMS[0];list=0/TEAM_2_EMPLOYEES/0"
	 * @param {function} fnRead
	 *   function like {@link sap.ui.model.odata.v4.ODataModel#read} which provides access to data
	 * @returns {Promise}
	 *   a promise which is resolved with the canonical URL (e.g.
	 *   "/<service root URL>/EMPLOYEES(ID='1')") in case of success, or rejected with an instance
	 *   of <code>Error</code> in case of failure
	 * @private
	 */
	ODataMetaModel.prototype.requestCanonicalUrl = function (sServiceUrl, sPath, fnRead) {
		var that = this;

		return Promise.all([
			fnRead(sPath, true),
			this.requestMetaContext(sPath)
		]).then(function (aValues) {
			var oEntityInstance = aValues[0],
				oMetaContext = aValues[1];

			return that.requestObject("", oMetaContext).then(function (oEntitySet) {
				// check that this really is an EntitySet
				if (!oEntitySet.EntityType) {
					error("Not an entity", sPath);
				}
				return that.requestObject("EntityType", oMetaContext).then(function (oEntityType) {
					return sServiceUrl + encodeURIComponent(oEntitySet.Name)
						+ Helper.getKeyPredicate(oEntityType, oEntityInstance);
				});
			});
		});
	};

	/**
	 * Requests the meta data object for the given path relative to the given context.
	 *
	 * Returns a <code>Promise</code> which is resolved with the requested meta model object or
	 * rejected with an error.
	 *
	 * @param {string} sPath
	 *   A relative or absolute path within the meta model
	 * @param {sap.ui.model.Context} [oContext]
	 *   The context to be used as a starting point in case of a relative path
	 * @returns {Promise}
	 *   A promise which is resolved with the requested meta model object as soon as it is
	 *   available
	 */
	ODataMetaModel.prototype.requestObject = function (sPath, oContext) {
		var oPart,
			aSegments,
			sResolvedPath = this.resolve(sPath, oContext),
			that = this;

		/**
		 * Fetches and parses the next part of the path. Modifies aSegments
		 * @returns {object}
		 *   an object describing the part with property and name
		 */
		function nextPart() {
			return Helper.parseSegment(aSegments.shift());
		}

		/**
		 * Throws an error that the segment is unknown.
		 * @param {string} sSegment
		 *   the segment
		 */
		function unknown(sSegment) {
			error("Unknown " + sSegment, sPath);
		}

		function followPath(oObject) {
			var oNextObject;

			while (aSegments.length) {
				oPart = nextPart();
				if (!(oPart.property in oObject)) { // property does not exist
					unknown(oPart.segment);
				}
				oNextObject = oObject[oPart.property];
				if (oPart.name) {
					// a segment like "EntitySets('Employees')"
					if (!Array.isArray(oNextObject)) {
						error('"' + oPart.property + '" is not an array', sPath);
					}
					oObject = Helper.findInArray(oNextObject, "Name", oPart.name);
					if (!oObject) {
						unknown(oPart.segment);
					}
				} else {
					// a segment like "EntityType" or an index
					if (typeof oNextObject === "object" && !Array.isArray(oNextObject)
							&& Object.keys(oNextObject).length === 1) {
						// type navigation property not resolved yet
						return Helper.requestTypeForNavigationProperty(that, oObject,
								oPart.property)
							.then(followPath);
					}
					oObject = oNextObject;
				}
			}
			return oObject;
		}

		if (!sResolvedPath) {
			error("Not an absolute path", sPath);
		}
		aSegments = Helper.splitPath(sResolvedPath);
		return Helper.requestEntityContainer(this).then(followPath);
	};

	/**
	 * Requests the OData meta model context corresponding to the given OData model path.
	 *
	 * Returns a <code>Promise</code> which is resolved with the requested OData meta data context
	 * or rejected with an error.
	 *
	 * The resulting meta data context will either point to an EntitySet, to a Singleton or to a
	 * Property. The meta data path will follow the NavigationPropertyBindings as long as they lead
	 * to an EntitySet from the same container with a simple path, then it will switch to the type.
	 *
	 * @param {string} sPath
	 *   An absolute path within the OData data model for which the OData meta data context is
	 *   requested
	 * @returns {Promise}
	 *   A promise that gets resolved with the corresponding meta data context
	 *   (<code>sap.ui.model.Context</code>) within the meta model, as soon as all required meta
	 *   data to calculate this context is available; if no context can be determined, the promise
	 *   is rejected with the corresponding error
	 * @public
	 */
	ODataMetaModel.prototype.requestMetaContext = function (sPath) {
		var i = 0,
			sMetaPath = "",
			aSegments = Helper.splitPath(sPath),
			aMatches,
			that = this;

		/**
		 * Finds a child of the given object having the given name. Searches within all the given
		 * properties. Extends sMetaPath correspondingly.
		 *
		 * @param {object} oObject
		 *   the object to search in
		 * @param {string[]} aProperties
		 *   the names of the properties to search in (they must all be arrays)
		 * @param {string} sName
		 *   the value of the property "Name" in the searched child
		 * @param {boolean} [bHidden=false]
		 *   if true, sMetaPath is _not_ extended
		 * @returns {object}
		 *   the requested child or undefined if not found
		 */
		function findChild(oObject, aProperties, sName, bHidden) {
			var oChild,
				i,
				sProperty;

			for (i = 0; i < aProperties.length; i += 1) {
				sProperty = aProperties[i];
				if (sProperty in oObject) {
					oChild = Helper.findInArray(oObject[sProperty], "Name", sName);
					if (oChild) {
						if (!bHidden) {
							sMetaPath += "/" + sProperty + "('" + oChild.Name + "')";
						}
						return {object: oChild, property: sProperty};
					}
				}
			}
			return undefined;
		}

		/**
		 * Finds an EntitySet or a Singleton with the given name.
		 * @param {object} oEntityContainer
		 *   the entity container
		 * @param {string} sName
		 *   the name
		 * @param {boolean} [bHidden=false]
		 *   if true, sMetaPath is _not_ extended
		 * @returns {object}
		 *   the EntitySet or the Singleton
		 * @throws {Error}
		 *   if not found
		 */
		function findSetOrSingleton(oEntityContainer, sName, bHidden) {
			var oResult = findChild(oEntityContainer, ["EntitySets", "Singletons"], sName, bHidden);
			if (!oResult) {
				error("No EntitySet or Singleton with name '" + sName + "' found", sPath);
			}
			return oResult;
		}

		/**
		 * Follows the path from the given type corresponding to position <code>i - 1</code> in
		 * <code>aSegments</code> until the path is exhausted.
		 * @param {object} oType
		 *   the type
		 * @returns {string}
		 *   the meta path
		 */
		function followPath(oType) {
			var oProperty,
				oResult;

			if (!aSegments[i]) {
				return sMetaPath;
			}

			for (;;) {
				oResult = findChild(oType, ["Properties", "NavigationProperties"], aSegments[i]);
				if (!oResult) {
					error("Unknown property: " + oType.QualifiedName + "/" + aSegments[i], sPath);
				}
				oProperty = oResult.object;
				i += 1;
				if (rNumber.test(aSegments[i])) {
					i += 1;  // skip index in data path e.g. .../TEAM_2_EMPLOYEES/2/Name
				}

				if (!aSegments[i]) {
					return sMetaPath;
				}
				sMetaPath = sMetaPath + "/Type";
				if (Object.keys(oProperty.Type).length === 1) {
					// type navigation property not resolved yet
					return Helper.requestTypeForNavigationProperty(that, oProperty, "Type")
						.then(followPath);
				}
				oType = oProperty.Type;
			}
		}

		if (aSegments.length === 0) {
			error("Unsupported", sPath);
		}
		aMatches = rEntitySetName.exec(aSegments[0]);
		if (!aMatches) {
			error("Unsupported", sPath);
		}
		return Helper.requestEntityContainer(this).then(function (oEntityContainer) {
			var sName = aMatches[1],
				oNavigationResult,
				sProperty,
				oResult;

			oResult = findSetOrSingleton(oEntityContainer, sName);
			// follow the NavigationPropertyBindings in EntitySets/Singletons until a stuctural
			// property
			for (;;) {
				sProperty = oResult.property === "EntitySets" ? "EntityType" : "Type";
				i += 1;
				if (rNumber.test(aSegments[i])) {
					// skip index in data path e.g. .../TEAM_2_EMPLOYEES/2/Name
					i += 1;
				}
				if (!aSegments[i]) {
					return sMetaPath;
				}
				oNavigationResult = findChild(oResult.object, ["NavigationPropertyBindings"],
					aSegments[i]);
				if (!oNavigationResult) {
					break;
				}
				sName = oNavigationResult.object.Target.Name;
				if (!sName) {
					// if it is local, Helper.resolveNavigationPropertyBindings has inserted the
					// entity set or singleton here
					error("Unsupported cross-service reference", sPath);
				}
				// This search is only used to check whether it is entity set or singleton
				oResult = findSetOrSingleton(oEntityContainer, sName, true);
				sMetaPath += "/Target";
			}
			sMetaPath += "/" + sProperty;
			return Helper.requestTypeForNavigationProperty(that, oResult.object, sProperty)
				.then(followPath);
		}).then(function (sMetaPath) {
			return that.getContext(sMetaPath);
		});
	};

	var mUi5TypeForEdmType = {
			"Edm.Boolean" : {type : "sap.ui.model.odata.type.Boolean"},
			"Edm.Byte" : {type : "sap.ui.model.odata.type.Byte"},
			"Edm.Date" : {type: "sap.ui.model.odata.type.Date"},
//			"Edm.DateTimeOffset" : {type : "sap.ui.model.odata.type.DateTimeOffset"},
			"Edm.Decimal" : {
				type : "sap.ui.model.odata.type.Decimal",
				facets : {"Precision": "precision", "Scale" : "scale"}
			},
			"Edm.Double" : {type: "sap.ui.model.odata.type.Double"},
			"Edm.Guid" : {type: "sap.ui.model.odata.type.Guid"},
			"Edm.Int16" : {type: "sap.ui.model.odata.type.Int16"},
			"Edm.Int32" : {type: "sap.ui.model.odata.type.Int32"},
			"Edm.Int64" : {type: "sap.ui.model.odata.type.Int64"},
			"Edm.SByte" : {type: "sap.ui.model.odata.type.SByte"},
			"Edm.Single" : {type: "sap.ui.model.odata.type.Single"},
			"Edm.String" : {
				type : "sap.ui.model.odata.type.String",
				facets : {"MaxLength" : "maxLength"}
			}
		};

	/**
	 * Requests the UI5 type for the given property path that formats and parses corresponding to
	 * the property's EDM type and facets. The property's type must be a primitive type.
	 *
	 * @param {string} sPath
	 *   An absolute path to an OData property within the OData data model
	 * @returns {Promise}
	 *   A promise that gets resolved with the corresponding UI5 type from
	 *   <code>sap.ui.model.odata.type</code>; if no type can be determined, the promise is
	 *   rejected with the corresponding error
	 * @public
	 */
	ODataMetaModel.prototype.requestUI5Type = function (sPath) {
		var that = this;

		return this.requestMetaContext(sPath).then(function (oMetaContext) {
			return that.requestObject("", oMetaContext);
		}).then(function (oProperty) {
			var oConstraints,
				oFacet,
				i,
				oUi5Type;

			function setConstraint(sKey, vValue) {
				oConstraints = oConstraints || {};
				oConstraints[sKey] = vValue;
			}

			if (!("Type" in oProperty) || !("Facets" in oProperty) || !("Nullable" in oProperty)) {
				error("No property", sPath);
			}
			oUi5Type = mUi5TypeForEdmType[oProperty.Type.QualifiedName];
			if (!oUi5Type) {
				error("Unsupported EDM type: " + oProperty.Type.QualifiedName, sPath);
			}
			for (i = 0; i < oProperty.Facets.length; i++) {
				oFacet = oProperty.Facets[i];
				if (oUi5Type.facets && oFacet.Name in oUi5Type.facets) {
					setConstraint(oUi5Type.facets[oFacet.Name], oFacet.Value);
				}
			}
			if (!oProperty.Nullable) {
				setConstraint("nullable", false);
			}
			return new (jQuery.sap.getObject(oUi5Type.type, 0))({}, oConstraints);
		});
	};

	return ODataMetaModel;
}, /* bExport= */ true);
