'use strict';

describe('WorkerSetupCtrl', function() {
	beforeEach(module('awsSetup'));
	
	var $rootScope, $controller, $httpBackend, $q, $analyticsMock;
		
	beforeEach(inject(function(_$controller_, _$rootScope_, _$httpBackend_, _$q_) {
		$rootScope = _$rootScope_;
		$controller = _$controller_;
		$httpBackend = _$httpBackend_;
		$q = _$q_;
	}));
	
	var ctrl, localStorageService, amiListHandler, instanceHandler, awsServiceMock;
	
	beforeEach(function() {
		amiListHandler = $httpBackend.when('GET', 'amiList.json').respond({
			"amis": [
			 		{
			 			"ami": "ami-0529086c",
			 			"blenderVersion": "2.69",
			 			"nginxPath": "/usr/share/nginx/www/"
			 		},
			 		{
			 			"ami": "ami-test",
			 			"blenderVersion": "2.77"
			 		}
			 	],
			 	"defaultNginxPath": "/usr/share/nginx/html/" 
			 });
		
		$analyticsMock = jasmine.createSpyObj('$analyticsMock', ['eventTrack']);
		
		awsServiceMock = getAwsServiceMock();
		
		awsServiceMock.getAvailabilityZones.and.returnValue(['zone1', 'zone2']);
		
		instanceHandler = $httpBackend.when('GET', 'instances.json').respond(['c1.xlarge', 'm3.2xlarge']);
		
		//Mock up inherited scope objects
		$rootScope.s3 = {
			projectSource: 'source location',
			frameDestination: 'frame dest',
			isEbsSource: function() {
				return false;
			}
		};
		
		$rootScope.queue = {
			workQueue: 'queueName'
		};
		
		ctrl = $controller('WorkerSetupCtrl', {$scope: $rootScope, localStorageService: localStorageService, awsService: awsServiceMock, $analytics: $analyticsMock});
		$rootScope.$broadcast('brenda-web-credentials-updated');
	});
	
	it('should start with spot selected as default', function() {
		expect($rootScope.instanceType).toBe('spot');
	});
	
	it('should populate list based on http response and default select first item', function() {
		$httpBackend.flush();
		expect($rootScope.amis.length).toBe(2);
		expect($rootScope.amis[0]).toEqual({name: 'ami-0529086c', version: '2.69', nginxPath: '/usr/share/nginx/www/'});
		expect($rootScope.amis[1]).toEqual({name: 'ami-test', version: '2.77', nginxPath: '/usr/share/nginx/html/'});
		expect($rootScope.amiSelect).toBe('');
	});
	
	it('should set the default nginx path', function() {
		$httpBackend.flush();
		expect($rootScope.amiNginxPath).toBe('/usr/share/nginx/html/')
	});
	
	it('should populate instance list based on http response', function() {
		$httpBackend.flush();
		expect($rootScope.instances.length).toBe(2);
		expect($rootScope.instances[0]).toEqual({name: 'c1.xlarge', spotPrices: {zone1: undefined, zone2: undefined}});
		expect(awsServiceMock.getSpotPrices).toHaveBeenCalled();
	});
	
	describe('$scope.setAmi', function() {
		beforeEach(function() {
			$httpBackend.flush();
		});
		
		it('should set amiSelect and amiNginxPath based on item passed', function() {
			$rootScope.setAmi({name: 'ami-test', nginxPath: '/path/to/nginx/'});
			expect($rootScope.amiSelect).toBe('ami-test');
			expect($rootScope.amiNginxPath).toBe('/path/to/nginx/');
		});
	});
	
	describe('$scope.$on(aws-spotprice-update', function() {
		beforeEach(function() {
			$httpBackend.flush();
		});
		
		it('should update prices on data received', function() {
			var curDate = new Date();
			$rootScope.$broadcast('aws-spotprice-update', {SpotPriceHistory: 
				[
				 	{InstanceType: 'c1.xlarge', AvailabilityZone: 'zone1', Timestamp: curDate, SpotPrice: 0.023},
				 	{InstanceType: 'c1.xlarge', AvailabilityZone: 'zone1', Timestamp: new Date(curDate - 100), SpotPrice: 0.025}	//Older data should be ignored
			 	]});
			
			expect($rootScope.instances[0].spotPrices).toEqual({zone1: {price: 0.023, tstamp: curDate}, zone2: undefined});
		})
		
		it('should call for next data if next token present', function() {
			$rootScope.$broadcast('aws-spotprice-update', {SpotPriceHistory: [], NextToken: '123abc'});
			
			expect(awsServiceMock.getSpotPrices).toHaveBeenCalledWith('123abc');
		})
	});
	
	describe('$scope.$on(aws-spotprice-error', function() {
		beforeEach(function() {
			$httpBackend.flush();
		});
		
		it('should set error on error received', function() {
			$rootScope.$broadcast('aws-spotprice-error', 'error');
			expect($rootScope.spotErrors.error).toBe('error');
		});
	});
	
	it('should return the currently selected instance when getSelectedInstance is called', function() {
		$httpBackend.flush();
		$rootScope.instance.size = 'c1.xlarge';
		expect($rootScope.getSelectedInstance()).toEqual({name: 'c1.xlarge', spotPrices: {zone1: undefined, zone2: undefined}});
	});
	
	it('should populate $scope.keys on callback from awsService.getKeyPairs', function() {
		expect(awsServiceMock.getKeyPairs).toHaveBeenCalled();
		var callback = awsServiceMock.getKeyPairs.calls.argsFor(0)[0];
		callback({KeyPairs: [{KeyName: 'key1'}, {KeyName: 'key2'}]});
		expect($rootScope.keys.length).toBe(2);
		expect($rootScope.keys[0]).toBe('key1');
		expect($rootScope.keys[1]).toBe('key2');
	});
	
	describe('generateScript', function() {
		it('should generate the startup script correctly', function() {
			$httpBackend.flush();
			
			var expected = 
				'#!/bin/bash\n' +
				'# run Brenda on the EC2 instance store volume\n' +
				'B="/mnt/brenda"\n' +
				'sudo apt-get update\n' +
				'sudo apt-get -y install nginx\n' +
				"sudo sed -i '29 i\\ add_header 'Access-Control-Allow-Origin' '*';' /etc/nginx/sites-enabled/default\n" +
				'sudo echo "* * * * * root tail -n1000 /mnt/brenda/log > /usr/share/nginx/html/log_tail.txt" >> /etc/crontab\n' +
				'sudo echo "* * * * * root cat /proc/uptime /proc/loadavg $B/task_count > /usr/share/nginx/html/uptime.txt" >> /etc/crontab\n' +
				'if ! [ -d "$B" ]; then\n' +
				'  for f in brenda.pid log task_count task_last DONE ; do\n' +
				'    ln -s "$B/$f" "/root/$f"\n' +
				'    sudo ln -s "$B/$f" "/usr/share/nginx/html/$f"\n' +
				'  done\n' +
				'fi\n' +
				'sudo service nginx restart\n' +
				'export BRENDA_WORK_DIR="."\n' +
				'mkdir -p "$B"\n' +
				'cd "$B"\n' +
				'/usr/local/bin/brenda-node --daemon <<EOF\n' +
				'AWS_ACCESS_KEY=accessKey\n' +
				'AWS_SECRET_KEY=secretKey\n' +
				'BLENDER_PROJECT=source location\n' +
				'WORK_QUEUE=sqs://queueName\n' +
				'RENDER_OUTPUT=frame dest\n' +
				'DONE=shutdown\n' +
				'EOF\n';
			var script = $rootScope.generateScript();
			
			expect(script).toEqual(expected);
		});
	});
	
	describe('$scope.requestInstances', function() {
		beforeEach(function() {
			$rootScope.instanceType = 'spot';
			$rootScope.amiSelect = 'ami_123';
			$rootScope.sshKey = 'key';
			$rootScope.generateScript = function() {
				return 'script';
			};
			$rootScope.instance = {size: 'c3.large'};
			$rootScope.spotPrice = '0.02';
			$rootScope.numInstances = 1;
		});
		
		it('should call requestSpot method when spot instances being requested', function() {
			$rootScope.requestInstances();
			expect(awsServiceMock.requestSpot).toHaveBeenCalledWith('ami_123', 'key', 'brenda-web', 'script', 'c3.large', null, '0.02', 1, 'one-time', 'queueName', 'frame dest', jasmine.any(Function));
		});
		
		it('should call reqstOndemand method when on demand instances being requested', function() {
			$rootScope.instanceType = 'onDemand';
			$rootScope.requestInstances();
			expect(awsServiceMock.requestOndemand).toHaveBeenCalledWith('ami_123', 'key', 'brenda-web', 'script', 'c3.large', null, 1, 'queueName', 'frame dest', jasmine.any(Function));
		});
		
		it('should call requestSpot with snapshot if using ebs style project source', function() {
			$rootScope.s3.projectSource = 'ebs://snap-123';
			$rootScope.s3.isEbsSource = function() {return true;};
			$rootScope.requestInstances();
			expect(awsServiceMock.requestSpot).toHaveBeenCalledWith('ami_123', 'key', 'brenda-web', 'script', 'c3.large', ['snap-123'], '0.02', 1, 'one-time', 'queueName', 'frame dest', jasmine.any(Function));
		});
	});
	
	describe('$scope.showStatus', function() {
		it('should replace any existing statuses', function() {
			$rootScope.statuses.push({type: 'test', text: 'message'});
			
			$rootScope.showStatus('warning', 'warn message');
			expect($rootScope.statuses.length).toBe(1);
			expect($rootScope.statuses[0]).toEqual({type: 'warning', text: 'warn message'});
		});
	});
});